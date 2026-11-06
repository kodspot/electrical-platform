'use strict';

// A resident can ask for their details to be erased (DPDP s.12), but the only tool was the job
// that clears them at 180 days, so a request could not be met sooner. An admin can now erase the
// reporter of one complaint; the ticket stays as the maintenance record. [BUG-0081]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestAuditLog } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('BUG-0081: an admin can erase the reporter of one complaint', () => {
  let dbAvailable = false;
  let app, org, otherOrg, location, adminAuth, supAuth, otherAdminAuth;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.5.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const erase = (auth, id) => app.inject({ method: 'POST', url: `/api/tickets/${id}/erase-reporter`, headers: auth, payload: {} });
  const complaint = async () => {
    const ticket = await createTestTicket(org.id, location.id, { source: 'PUBLIC', guestName: 'Asha Rao', guestPhone: '+91 98765 43210', sourceIp: 'abc123', userAgent: 'Mozilla' });
    const row = await createTestAuditLog(org.id, {
      actorType: 'guest', actorId: 'Asha Rao', action: 'ticket_public_create', entityType: 'Ticket', entityId: ticket.id,
      newValue: { issueType: 'NO_POWER', locationName: 'Room 12', guestName: 'Asha Rao' }
    });
    return { ticket, row };
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    location = await createTestLocation(org.id);
    adminAuth = await login(await createTestUser(org.id, { role: 'ADMIN' }));
    supAuth = await login(await createTestUser(org.id, { role: 'SUPERVISOR' }));
    otherAdminAuth = await login(await createTestUser(otherOrg.id, { role: 'ADMIN' }));
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('clears the details on the ticket and in its audit row, keeps the ticket, and records the erasure without the name', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { ticket, row } = await complaint();
    const res = await erase(adminAuth, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);

    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    assert.deepStrictEqual([after.guestName, after.guestPhone, after.sourceIp, after.userAgent], [null, null, null, null]);
    assert.strictEqual(after.title, ticket.title);

    const scrubbed = await prisma.auditLog.findUnique({ where: { id: row.id } });
    assert.strictEqual(scrubbed.actorId, 'anonymous');
    assert.strictEqual(scrubbed.newValue.guestName, undefined);
    assert.strictEqual(scrubbed.newValue.issueType, 'NO_POWER');

    const erased = await prisma.auditLog.findFirst({ where: { orgId: org.id, entityId: ticket.id, action: 'ticket_reporter_erased' } });
    assert.ok(erased);
    assert.ok(!JSON.stringify(erased).includes('Asha'));
  });

  it('is for admins: a supervisor is refused and nothing changes', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { ticket } = await complaint();
    const res = await erase(supAuth, ticket.id);
    assert.strictEqual(res.statusCode, 403, res.body);
    assert.strictEqual((await prisma.ticket.findUnique({ where: { id: ticket.id } })).guestName, 'Asha Rao');
  });

  it("another organization's complaint answers 404 and nothing changes", async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { ticket } = await complaint();
    const res = await erase(otherAdminAuth, ticket.id);
    assert.strictEqual(res.statusCode, 404, res.body);
    assert.strictEqual((await prisma.ticket.findUnique({ where: { id: ticket.id } })).guestName, 'Asha Rao');
  });

  it('a staff-created ticket has no reporter to erase', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { source: 'INTERNAL' });
    const res = await erase(adminAuth, ticket.id);
    assert.strictEqual(res.statusCode, 400, res.body);
  });
});
