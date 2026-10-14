'use strict';

// F13 / BUG-0009: DELETE /supervisors/:id/permanent checked only inspection history, but six
// foreign keys reference a User with ON DELETE RESTRICT (Ticket.createdById,
// Attendance.markedById, DutyRoster.supervisorId, AssetEvent.loggedById,
// AssetFailure.loggedById, ElectricalInspection.supervisorId). Any of the first five made
// prisma.user.delete fail on the constraint (500) instead of a clear 409. The route now
// pre-checks every blocking reference, with the same 409 shape as the inspection check.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestTicket,
  createTestWorker, createTestAttendance, createTestDutyRoster, createTestAsset, createTestAssetEvent, createTestAssetFailure
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('F13 — supervisor permanent delete is blocked (409) by every RESTRICT reference, never a 500', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, otherOrg, adminToken, otherAdminToken, location;
  let ip = 0;

  const login = async (u) => (await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.93.0.${++ip}` },
    payload: { email: u.email, password: u.plaintextPassword }
  })).json().token;
  const del = (id, token = adminToken) => app.inject({
    method: 'DELETE', url: `/api/supervisors/${id}/permanent`, headers: { authorization: `Bearer ${token}` }
  });
  const inactiveSupervisor = () => createTestUser(org.id, { role: 'SUPERVISOR', isActive: false });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    adminToken = await login(await createTestUser(org.id, { role: 'ADMIN' }));
    otherAdminToken = await login(await createTestUser(otherOrg.id, { role: 'ADMIN' }));
    location = await createTestLocation(org.id);
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  async function expectBlocked(t, supervisor, field) {
    const res = await del(supervisor.id);
    assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body.slice(0, 160)}`);
    const body = res.json();
    assert.match(body.error, /Cannot permanently delete supervisor/);
    assert.ok(body[field] >= 1, `the 409 names the blocking records (${field})`);
    assert.ok(await prisma.user.findUnique({ where: { id: supervisor.id } }), 'the supervisor is kept');
  }

  it('a supervisor who created a ticket → 409 (was a foreign-key 500)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sup = await inactiveSupervisor();
    await createTestTicket(org.id, location.id, { createdById: sup.id });
    await expectBlocked(t, sup, 'ticketsCreated');
  });

  it('a supervisor who marked attendance → 409', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sup = await inactiveSupervisor();
    const worker = await createTestWorker(org.id);
    await createTestAttendance(org.id, worker.id, sup.id);
    await expectBlocked(t, sup, 'attendanceMarked');
  });

  it('a supervisor on a duty roster → 409', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sup = await inactiveSupervisor();
    await createTestDutyRoster(org.id, location.id, sup.id);
    await expectBlocked(t, sup, 'dutyRosters');
  });

  it('a supervisor who logged asset events or failures → 409', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const asset = await createTestAsset(org.id, location.id);
    const supA = await inactiveSupervisor();
    await createTestAssetEvent(org.id, asset.id, supA.id);
    await expectBlocked(t, supA, 'assetEventsLogged');
    const supB = await inactiveSupervisor();
    await createTestAssetFailure(org.id, asset.id, supB.id);
    await expectBlocked(t, supB, 'assetFailuresLogged');
  });

  it('a supervisor with no history is still deleted (200)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sup = await inactiveSupervisor();
    const res = await del(sup.id);
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 160));
    assert.strictEqual(await prisma.user.findUnique({ where: { id: sup.id } }), null);
  });

  it('tenant isolation: another org\'s admin gets 404 and the supervisor is kept', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sup = await inactiveSupervisor();
    await createTestTicket(org.id, location.id, { createdById: sup.id });
    const res = await del(sup.id, otherAdminToken);
    assert.strictEqual(res.statusCode, 404);
    assert.ok(await prisma.user.findUnique({ where: { id: sup.id } }));
  });
});
