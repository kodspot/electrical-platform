'use strict';

// ESCALATION_CHECKS (services/automation.js runEscalationChecks, every 5 minutes in
// production) — deterministic: alerts are back-dated past the rule's window instead of
// waiting on a clock, and the check is called directly. The alert itself is raised through
// the real route (POST /api/tickets with priority HIGH → TICKET_HIGH_PRIORITY), so the
// payload the escalation reads is the one production stores. Closes the COVERAGE_MATRIX P1
// "SLA escalation behaviour is untested" for alerts, and holds the regression BUG-0019.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  cleanupTestOrgs,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestWorker,
  createTestWorkerAssignment,
  createTestSupervisorAssignment
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { runEscalationChecks } = require('../../src/services/automation');

async function eventually(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

describe('ESCALATION_CHECKS — an unacknowledged alert escalates on time, to the right people, at most maxEscalations times', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, otherOrg, admin, otherAdmin, supervisor, otherSupervisor, worker, location, adminToken;
  let ip = 0;

  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.66.0.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json().token;
  };

  /** A HIGH ticket through the real route; returns the TICKET_HIGH_PRIORITY alert it raised. */
  const raiseAlert = async (title) => {
    const res = await app.inject({ method: 'POST', url: '/api/tickets', headers: { authorization: `Bearer ${adminToken}` }, payload: { locationId: location.id, title, priority: 'HIGH' } });
    assert.strictEqual(res.statusCode, 200, res.body);
    const ticketId = res.json().id;
    const alert = await eventually(() => prisma.alert.findFirst({ where: { orgId: org.id, entityId: ticketId } }));
    assert.ok(alert, 'the HIGH ticket raised an alert');
    return alert;
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    otherAdmin = await createTestUser(otherOrg.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    otherSupervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);
    await createTestSupervisorAssignment(org.id, supervisor.id, location.id);
    worker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, worker.id, location.id);
    adminToken = await login(admin);

    // The rule, through the admin's own route: escalate after 10 minutes, at most twice, to the
    // supervisors and electricians assigned to the location, and raise an urgent ticket.
    const rule = await app.inject({
      method: 'POST', url: '/api/alert-rules', headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'High-priority tickets', trigger: 'TICKET_HIGH_PRIORITY', conditions: { minPriority: 'HIGH' },
        actions: [{ type: 'NOTIFY_ADMINS' }],
        escalateAfterMinutes: 10, maxEscalations: 2,
        escalationActions: [{ type: 'NOTIFY_ASSIGNED_SUPERVISORS' }, { type: 'NOTIFY_ASSIGNED_WORKERS' }, { type: 'CREATE_TICKET', priority: 'URGENT' }]
      }
    });
    assert.ok([200, 201].includes(rule.statusCode), rule.body);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('nothing escalates before the window; after it, level 1 and the admins are told', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const alert = await raiseAlert('Sparking socket A');

    await runEscalationChecks();
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: alert.id } })).escalationLevel, 0, 'not yet due');

    await prisma.alert.update({ where: { id: alert.id }, data: { createdAt: minutesAgo(11) } });
    await runEscalationChecks();
    const now = await prisma.alert.findUnique({ where: { id: alert.id } });
    assert.strictEqual(now.escalationLevel, 1);
    assert.ok(now.lastEscalatedAt);
    const told = await prisma.notification.findFirst({ where: { userId: admin.id, entityId: alert.id, type: 'escalation' } });
    assert.ok(told, 'the admin got the escalation notification');
    assert.match(told.title, /Level 1/);
    assert.strictEqual(await prisma.notification.count({ where: { userId: otherAdmin.id } }), 0, 'another org is never told');
  });

  it('BUG-0019: the escalation reaches the supervisor and electrician assigned to the location, and raises its ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const alert = await raiseAlert('Sparking socket B');
    await prisma.alert.update({ where: { id: alert.id }, data: { createdAt: minutesAgo(11) } });
    await runEscalationChecks();

    const forSupervisor = await prisma.notification.count({ where: { userId: supervisor.id, entityId: alert.id } });
    const forWorker = await prisma.notification.count({ where: { workerId: worker.id, entityId: alert.id } });
    const autoTicket = await prisma.ticket.findFirst({ where: { orgId: org.id, title: `[Auto] ${alert.title}` } });
    assert.strictEqual(forSupervisor, 1, 'NOTIFY_ASSIGNED_SUPERVISORS reached the location\'s supervisor');
    assert.strictEqual(forWorker, 1, 'NOTIFY_ASSIGNED_WORKERS reached the location\'s electrician');
    assert.ok(autoTicket, 'CREATE_TICKET raised a ticket');
    assert.strictEqual(autoTicket.locationId, location.id);
    assert.strictEqual(autoTicket.priority, 'URGENT');
    assert.strictEqual(await prisma.notification.count({ where: { userId: otherSupervisor.id, entityId: alert.id } }), 0, 'a supervisor elsewhere is not');
  });

  it('it re-escalates only after another full window, and stops at maxEscalations', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const alert = await raiseAlert('Sparking socket C');
    await prisma.alert.update({ where: { id: alert.id }, data: { createdAt: minutesAgo(30) } });
    await runEscalationChecks();
    await runEscalationChecks();
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: alert.id } })).escalationLevel, 1, 'the second run is inside the new window');

    await prisma.alert.update({ where: { id: alert.id }, data: { lastEscalatedAt: minutesAgo(11) } });
    await runEscalationChecks();
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: alert.id } })).escalationLevel, 2);

    await prisma.alert.update({ where: { id: alert.id }, data: { lastEscalatedAt: minutesAgo(60) } });
    await runEscalationChecks();
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: alert.id } })).escalationLevel, 2, 'maxEscalations = 2');
    assert.strictEqual(await prisma.notification.count({ where: { userId: admin.id, entityId: alert.id, type: 'escalation' } }), 2);
  });

  it('an acknowledged alert, or one whose rule was switched off, never escalates', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const acked = await raiseAlert('Sparking socket D');
    const ack = await app.inject({ method: 'PATCH', url: `/api/alerts/${acked.id}/acknowledge`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(ack.statusCode, 200, ack.body);
    await prisma.alert.update({ where: { id: acked.id }, data: { createdAt: minutesAgo(60) } });

    const off = await raiseAlert('Sparking socket E');
    await prisma.alert.update({ where: { id: off.id }, data: { createdAt: minutesAgo(60) } });
    await prisma.alertRule.update({ where: { id: off.ruleId }, data: { isActive: false } });
    try {
      await runEscalationChecks();
    } finally {
      await prisma.alertRule.update({ where: { id: off.ruleId }, data: { isActive: true } });
    }
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: acked.id } })).escalationLevel, 0);
    assert.strictEqual((await prisma.alert.findUnique({ where: { id: off.id } })).escalationLevel, 0);
  });
});
