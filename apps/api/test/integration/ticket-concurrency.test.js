'use strict';

// Two people acting on one ticket at the same moment. Every transition read the ticket,
// checked its status, then updated it by id alone — so both requests "succeeded" and the last
// write won: a fix could end up verified AND sent back, verified twice (two notifications,
// two audit rows), or picked up by two supervisors. Each transition now writes only if the
// status is still the one it checked; the loser gets 409 (or 400 once the change is visible).
// [BUG-0038]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const ROUNDS = 6;

describe('BUG-0038: concurrent ticket transitions — exactly one wins', () => {
  let dbAvailable = false;
  let app, org, location, admin, supA, supB, adminAuth, supAAuth, supBAuth;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.4.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const post = (auth, url, payload = {}) => app.inject({ method: 'POST', url, headers: auth, payload });
  const winners = (results) => results.filter((r) => r.statusCode === 200).length;
  const auditCount = (ticketId, actions) => prisma.auditLog.count({ where: { orgId: org.id, entityId: ticketId, action: { in: actions } } });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supA = await createTestUser(org.id, { role: 'SUPERVISOR' });
    supB = await createTestUser(org.id, { role: 'SUPERVISOR' });
    adminAuth = await login(admin);
    supAAuth = await login(supA);
    supBAuth = await login(supB);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('verify and "reject & reopen" at the same time: one wins, and the ticket ends in that one\'s state', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (let i = 0; i < ROUNDS; i++) {
      const ticket = await createTestTicket(org.id, location.id, { status: 'RESOLVED_PENDING_VERIFY', assignedToId: supA.id, resolvedAt: new Date() });
      const [verify, reopen] = await Promise.all([
        post(supAAuth, `/api/tickets/${ticket.id}/verify`),
        post(adminAuth, `/api/tickets/${ticket.id}/reopen`, { note: 'Still sparking' })
      ]);
      assert.strictEqual(winners([verify, reopen]), 1, `round ${i}: verify ${verify.statusCode}, reopen ${reopen.statusCode}`);
      const now = await prisma.ticket.findUnique({ where: { id: ticket.id } });
      assert.strictEqual(now.status, verify.statusCode === 200 ? 'RESOLVED' : 'IN_PROGRESS', `round ${i}: the ticket is in the winner's state`);
      assert.strictEqual(await auditCount(ticket.id, ['ticket_verified', 'ticket_reopened']), 1, `round ${i}: one audit row`);
    }
  });

  it('verified twice at once (assigned supervisor and admin): once', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (let i = 0; i < ROUNDS; i++) {
      const ticket = await createTestTicket(org.id, location.id, { status: 'RESOLVED_PENDING_VERIFY', assignedToId: supA.id, resolvedAt: new Date() });
      const results = await Promise.all([post(supAAuth, `/api/tickets/${ticket.id}/verify`), post(adminAuth, `/api/tickets/${ticket.id}/verify`)]);
      assert.strictEqual(winners(results), 1, `round ${i}: ${results.map((r) => r.statusCode)}`);
      assert.strictEqual(await auditCount(ticket.id, ['ticket_verified']), 1, `round ${i}: one audit row`);
    }
  });

  it('two supervisors pick up the same unassigned ticket at once: one gets it', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (let i = 0; i < ROUNDS; i++) {
      const ticket = await createTestTicket(org.id, location.id, { status: 'OPEN' });
      const [a, b] = await Promise.all([post(supAAuth, `/api/tickets/${ticket.id}/pickup`), post(supBAuth, `/api/tickets/${ticket.id}/pickup`)]);
      assert.strictEqual(winners([a, b]), 1, `round ${i}: ${a.statusCode}, ${b.statusCode}`);
      const now = await prisma.ticket.findUnique({ where: { id: ticket.id } });
      assert.strictEqual(now.assignedToId, a.statusCode === 200 ? supA.id : supB.id, `round ${i}: the winner holds it`);
    }
  });
});
