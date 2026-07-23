'use strict';

// Database-backed integration tests proving workers.js (routes/workers.js) never
// leaks or lets an admin mutate another org's Worker rows through the real HTTP API.
// Follows the exact pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestWorker,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — workers.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, locationA, workerA, workerB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    locationA = await createTestLocation(orgA.id);

    workerA = await createTestWorker(orgA.id, { name: '__wp1_test__ Worker A' });
    workerB = await createTestWorker(orgB.id, { name: '__wp1_test__ Worker B' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminA.email, password: adminA.plaintextPassword }
    });
    assert.strictEqual(loginRes.statusCode, 200, 'fixture login for Admin A must succeed');
    tokenA = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('GET /api/workers never returns another org\'s workers', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().workers.map((w) => w.id);
    assert.ok(ids.includes(workerA.id), 'Org A\'s own worker must be visible');
    assert.ok(!ids.includes(workerB.id), 'Org B\'s worker must never appear in Org A\'s list');
  });

  it('GET /api/workers/:id returns 404 (not 200 or 403) for another org\'s worker', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/workers/:id cannot modify another org\'s worker', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workers/${workerB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Worker' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/workers/by-location/:locationId rejects a foreign-org locationId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const locationB = await createTestLocation(orgB.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workers/by-location/${locationB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404, 'a location from another org must resolve as not found');
  });

  it('GET /api/workers/by-location/:locationId only returns workers assigned within the org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/workers/by-location/${locationA.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().workers.map((w) => w.id);
    assert.ok(!ids.includes(workerB.id), 'Org B\'s worker must never appear');
  });

  it('PUT /api/workers/:id/assignments rejects a foreign-org locationId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const locationB2 = await createTestLocation(orgB.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/workers/${workerA.id}/assignments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { locationIds: [locationB2.id] }
    });

    assert.strictEqual(res.statusCode, 400, 'a foreign-org location must not be assignable to Org A\'s worker');
  });
});
