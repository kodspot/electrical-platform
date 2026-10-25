'use strict';

// POST /api/alerts/run-checks and /api/alerts/run-escalations are ORG_ADMIN routes, but they
// started the platform-wide jobs — every tenant's checks and escalations — and outside the
// scheduler's advisory lock, so a manual run next to the scheduled one could escalate the same
// alert twice. The escalation scan also escalated alerts of suspended and deleted orgs.
// [BUG-0032]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { runEscalationChecks } = require('../../src/services/automation');
const { runExclusive, LOCK_KEYS } = require('../../src/lib/scheduler-lock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-0032: manual alert checks stay inside the caller\'s org and the scheduler lock', () => {
  let dbAvailable = false;
  let app, orgA, orgB, orgSuspended, authA;
  const createdOrgIds = [];

  /** An unacknowledged alert whose rule escalates after 1 minute, created 30 minutes ago. */
  const staleAlert = async (orgId) => {
    const rule = await prisma.alertRule.create({
      data: { orgId, name: '__wp1_test__ manual-check rule', trigger: 'TICKET_HIGH_PRIORITY', conditions: {}, actions: [], escalateAfterMinutes: 1, escalationActions: [], maxEscalations: 1 }
    });
    return prisma.alert.create({
      data: { orgId, ruleId: rule.id, trigger: 'TICKET_HIGH_PRIORITY', title: '__wp1_test__ manual-check alert', createdAt: new Date(Date.now() - 30 * 60000) }
    });
  };
  const level = async (alert) => (await prisma.alert.findUnique({ where: { id: alert.id } })).escalationLevel;
  const post = (url) => app.inject({ method: 'POST', url, headers: authA });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    orgA = await createTestOrg();
    orgB = await createTestOrg();
    orgSuspended = await createTestOrg({ status: 'SUSPENDED' });
    createdOrgIds.push(orgA.id, orgB.id, orgSuspended.id);
    const adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.88.2.1' }, payload: { email: adminA.email, password: adminA.plaintextPassword } });
    assert.strictEqual(login.statusCode, 200, login.body);
    authA = { authorization: `Bearer ${login.json().token}` };
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('run-escalations escalates the caller\'s org only — another org\'s overdue alert is left alone', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const mine = await staleAlert(orgA.id);
    const theirs = await staleAlert(orgB.id);
    const res = await post('/api/alerts/run-escalations');
    assert.strictEqual(res.statusCode, 200, res.body);
    // The old code ran the job in the background: give it time to reach every org.
    for (let i = 0; i < 40 && (await level(mine)) === 0; i++) await sleep(100);
    await sleep(1000);
    assert.strictEqual(await level(mine), 1, 'the caller\'s own alert escalates');
    assert.strictEqual(await level(theirs), 0, 'another org\'s alert was escalated');
  });

  for (const [route, key] of [['/api/alerts/run-checks', 'SCHEDULED_CHECKS'], ['/api/alerts/run-escalations', 'ESCALATION_CHECKS']]) {
    it(`${route} answers 409 while the scheduled job holds its lock`, async (t) => {
      if (!dbAvailable) return t.skip('No database available');
      let release;
      const held = new Promise((r) => { release = r; });
      let acquired = false;
      const scheduled = runExclusive(prisma, LOCK_KEYS[key], async () => { acquired = true; await held; });
      for (let i = 0; i < 50 && !acquired; i++) await sleep(50);
      assert.ok(acquired, 'the test holds the scheduled job\'s lock');
      try {
        const res = await post(route);
        assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body}`);
      } finally {
        release();
        await scheduled;
      }
      assert.strictEqual((await post(route)).statusCode, 200, 'once the lock is free it runs');
    });
  }

  it('the escalation scan leaves suspended organizations alone', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const suspended = await staleAlert(orgSuspended.id);
    await runEscalationChecks(undefined, { orgId: orgSuspended.id });
    assert.strictEqual(await level(suspended), 0);
  });
});
