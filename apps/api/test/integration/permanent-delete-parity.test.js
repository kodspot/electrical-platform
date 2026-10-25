'use strict';

// Regression tests for WP17 (Technical Debt Cleanup, finding L4). Covers the
// standardized permanent-delete dependency check between workers and
// supervisors.
//
// Before this fix, DELETE /supervisors/:id/permanent blocked (409) when the
// supervisor had electricalInspection history, but DELETE /workers/:id/permanent
// silently disconnected the worker from that same history (via the implicit
// many-to-many relation) and deleted anyway — losing the historical
// worker<->inspection association with no warning. Workers now block (409)
// with the same shape supervisors already used, instead of silently
// disconnecting.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestWorker,
  createTestLocation,
  createTestElectricalInspection,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('WP17 — worker/supervisor permanent-delete parity', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin, adminToken, location;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    location = await createTestLocation(org.id);

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    adminToken = login.json().token;
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('blocks permanent deletion of a deactivated worker with inspection history (409), preserving the association', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const worker = await createTestWorker(org.id, { isActive: false });
    const inspection = await createTestElectricalInspection(org.id, location.id, admin.id, {
      workers: { connect: [{ id: worker.id }] }
    });

    const res = await app.inject({
      method: 'DELETE', url: `/api/workers/${worker.id}/permanent`,
      headers: { authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.statusCode, 409, 'a worker with inspection history must be blocked from permanent deletion, matching supervisors.js');
    assert.strictEqual(res.json().electricalInspections, 1);

    const stillThere = await prisma.worker.findUnique({ where: { id: worker.id } });
    assert.ok(stillThere, 'the worker must not be deleted when blocked');

    const link = await prisma.electricalInspection.findFirst({
      where: { id: inspection.id, workers: { some: { id: worker.id } } }
    });
    assert.ok(link, "the worker's historical inspection association must be preserved, not silently disconnected");
  });

  // A duty roster references the worker with ON DELETE RESTRICT, so deleting failed with a
  // foreign-key error (500). Attendance records and resolved tickets cascade, so deleting
  // silently erased the worker's attendance history and their part in past fixes. All three
  // now block like inspection history does. [BUG-0035]
  it('BUG-0035: a worker on a duty roster is refused with 409, not a 500, and stays on the roster', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const worker = await createTestWorker(org.id, { isActive: false });
    const roster = await prisma.dutyRoster.create({ data: { orgId: org.id, date: new Date('2026-10-01'), shift: 'MORNING', locationId: location.id, supervisorId: admin.id, workers: { create: [{ workerId: worker.id }] } } });
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/workers/${worker.id}/permanent`, headers: { authorization: `Bearer ${adminToken}` } });
      assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode} ${res.body.slice(0, 120)}`);
      assert.strictEqual(res.json().dutyRosters, 1);
      assert.ok(await prisma.worker.findUnique({ where: { id: worker.id } }), 'the worker is kept');
      assert.strictEqual(await prisma.dutyRosterWorker.count({ where: { rosterId: roster.id, workerId: worker.id } }), 1);
    } finally {
      // The org cleanup cannot delete a worker a roster still names (RESTRICT): remove it first.
      await prisma.dutyRoster.deleteMany({ where: { id: roster.id } });
    }
  });

  it('BUG-0035: a worker with attendance records or resolved tickets is refused with 409, keeping that history', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const attended = await createTestWorker(org.id, { isActive: false });
    await prisma.attendance.create({ data: { orgId: org.id, workerId: attended.id, markedById: admin.id, date: new Date('2026-10-02'), shift: 'MORNING', status: 'PRESENT' } });
    const fixer = await createTestWorker(org.id, { isActive: false });
    const ticket = await prisma.ticket.create({ data: { orgId: org.id, locationId: location.id, title: '__wp1_test__ fixed by the worker', status: 'RESOLVED', resolvedWorkers: { connect: [{ id: fixer.id }] } } });

    const a = await app.inject({ method: 'DELETE', url: `/api/workers/${attended.id}/permanent`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(a.statusCode, 409, a.body);
    assert.strictEqual(a.json().attendanceRecords, 1);
    assert.strictEqual(await prisma.attendance.count({ where: { workerId: attended.id } }), 1, 'the attendance history is kept');

    const f = await app.inject({ method: 'DELETE', url: `/api/workers/${fixer.id}/permanent`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.strictEqual(f.statusCode, 409, f.body);
    assert.strictEqual(f.json().resolvedTickets, 1);
    assert.ok(await prisma.ticket.findFirst({ where: { id: ticket.id, resolvedWorkers: { some: { id: fixer.id } } } }), 'the ticket still names who fixed it');
  });

  it('still permanently deletes a deactivated worker with no inspection history', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const worker = await createTestWorker(org.id, { isActive: false });

    const res = await app.inject({
      method: 'DELETE', url: `/api/workers/${worker.id}/permanent`,
      headers: { authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.statusCode, 200, 'a worker with no dependent records must still be deletable, unchanged from before');

    const gone = await prisma.worker.findUnique({ where: { id: worker.id } });
    assert.strictEqual(gone, null);
  });

  it('rejects permanent deletion of a still-active worker, unchanged from before', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const worker = await createTestWorker(org.id, { isActive: true });

    const res = await app.inject({
      method: 'DELETE', url: `/api/workers/${worker.id}/permanent`,
      headers: { authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.statusCode, 400);
  });
});
