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
