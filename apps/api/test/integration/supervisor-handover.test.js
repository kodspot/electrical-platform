'use strict';

// A supervisor's open tickets stayed assigned to them after they were deactivated (or moved
// to another org by a super-admin): other supervisors never see a ticket assigned to someone
// else, and only the assigned supervisor or an admin may verify, so the work stranded. Now
// each open ticket is handed to the nearest active supervisor covering its location — the
// same rule a new complaint uses — or back to the pool. [BUG-0037]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestSupervisorAssignment } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('BUG-0037: a deactivated or moved supervisor\'s open tickets are handed over', () => {
  let dbAvailable = false;
  let app, org, otherOrg, admin, superAdmin, adminAuth, saAuth, covered, uncovered, backup;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.3.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const assigneeOf = async (ticket) => (await prisma.ticket.findUnique({ where: { id: ticket.id } })).assignedToId;

  /** A supervisor covering both locations, with an open, an in-progress, a pending-verify and a resolved ticket. */
  const supervisorWithWork = async () => {
    const sup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, sup.id, covered.id);
    await createTestSupervisorAssignment(org.id, sup.id, uncovered.id);
    const open = await createTestTicket(org.id, covered.id, { status: 'OPEN', assignedToId: sup.id });
    const working = await createTestTicket(org.id, covered.id, { status: 'IN_PROGRESS', assignedToId: sup.id });
    const toVerify = await createTestTicket(org.id, uncovered.id, { status: 'RESOLVED_PENDING_VERIFY', assignedToId: sup.id });
    const done = await createTestTicket(org.id, covered.id, { status: 'RESOLVED', assignedToId: sup.id });
    return { sup, open, working, toVerify, done };
  };
  const assertHandedOver = async ({ sup, open, working, toVerify, done }) => {
    assert.strictEqual(await assigneeOf(open), backup.id, 'an open ticket goes to the supervisor still covering the location');
    assert.strictEqual(await assigneeOf(working), backup.id, 'so does one in progress');
    assert.strictEqual(await assigneeOf(toVerify), null, 'with no one else covering, it returns to the pool');
    assert.strictEqual(await assigneeOf(done), sup.id, 'finished work keeps its history');
    const audits = await prisma.auditLog.count({ where: { orgId: org.id, action: 'ticket_reassigned', entityId: { in: [open.id, working.id, toVerify.id] } } });
    assert.strictEqual(audits, 3, 'each handover is audited');
    const told = await prisma.notification.count({ where: { userId: backup.id, entityId: { in: [open.id, working.id] } } });
    assert.strictEqual(told, 2, 'the new assignee is told');
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    covered = await createTestLocation(org.id);
    uncovered = await createTestLocation(org.id);
    backup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, backup.id, covered.id);
    adminAuth = await login(admin);
    saAuth = await login(superAdmin);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('deactivating through PATCH /supervisors/:id { isActive: false }', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const w = await supervisorWithWork();
    const res = await app.inject({ method: 'PATCH', url: `/api/supervisors/${w.sup.id}`, headers: adminAuth, payload: { isActive: false } });
    assert.strictEqual(res.statusCode, 200, res.body);
    await assertHandedOver(w);
  });

  it('deactivating through DELETE /supervisors/:id', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const w = await supervisorWithWork();
    const res = await app.inject({ method: 'DELETE', url: `/api/supervisors/${w.sup.id}`, headers: adminAuth });
    assert.strictEqual(res.statusCode, 200, res.body);
    await assertHandedOver(w);
  });

  it('a super-admin deactivating the user, or moving them to another org', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const off = await supervisorWithWork();
    const r1 = await app.inject({ method: 'PATCH', url: `/api/superadmin/users/${off.sup.id}`, headers: saAuth, payload: { isActive: false } });
    assert.strictEqual(r1.statusCode, 200, r1.body);
    await assertHandedOver(off);

    const moved = await supervisorWithWork();
    const r2 = await app.inject({ method: 'PATCH', url: `/api/superadmin/users/${moved.sup.id}`, headers: saAuth, payload: { orgId: otherOrg.id } });
    assert.strictEqual(r2.statusCode, 200, r2.body);
    assert.strictEqual(await assigneeOf(moved.open), backup.id, 'no ticket stays assigned to someone in another org');
    assert.strictEqual(await assigneeOf(moved.toVerify), null);
    assert.strictEqual(await prisma.supervisorAssignment.count({ where: { supervisorId: moved.sup.id, orgId: org.id } }), 0,
      'their coverage in the old org is dropped, so new complaints there stop reaching them');
  });

  it('editing an active supervisor (or reactivating one) moves nothing', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const w = await supervisorWithWork();
    const res = await app.inject({ method: 'PATCH', url: `/api/supervisors/${w.sup.id}`, headers: adminAuth, payload: { designation: 'Warden', isActive: true } });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(await assigneeOf(w.open), w.sup.id);
  });
});
