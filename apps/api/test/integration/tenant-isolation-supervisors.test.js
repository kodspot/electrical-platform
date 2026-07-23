'use strict';

// Database-backed integration tests proving supervisors.js (routes/supervisors.js) never
// leaks or lets an admin mutate another org's supervisor (User role=SUPERVISOR) rows
// through the real HTTP API. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
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
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — supervisors.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, supervisorA, supervisorB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    supervisorA = await createTestUser(orgA.id, { role: 'SUPERVISOR', name: '__wp1_test__ Supervisor A' });
    supervisorB = await createTestUser(orgB.id, { role: 'SUPERVISOR', name: '__wp1_test__ Supervisor B' });

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

  it('GET /api/supervisors never returns another org\'s supervisors', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/supervisors',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().supervisors.map((s) => s.id);
    assert.ok(ids.includes(supervisorA.id), 'Org A\'s own supervisor must be visible');
    assert.ok(!ids.includes(supervisorB.id), 'Org B\'s supervisor must never appear in Org A\'s list');
  });

  it('GET /api/supervisors/:id returns 404 (not 200 or 403) for another org\'s supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/supervisors/${supervisorB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/supervisors/:id cannot modify another org\'s supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/supervisors/${supervisorB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Supervisor' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/supervisors/:id cannot deactivate another org\'s supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/supervisors/${supervisorB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PUT /api/supervisors/:id/assignments rejects a foreign-org locationId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const locationB = await createTestLocation(orgB.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/supervisors/${supervisorA.id}/assignments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { locationIds: [locationB.id] }
    });

    assert.strictEqual(res.statusCode, 400, 'a foreign-org location must not be assignable to Org A\'s supervisor');
  });

  it('PUT /api/supervisors/:id/assignments cannot target another org\'s supervisor at all', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const locationA = await createTestLocation(orgA.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/supervisors/${supervisorB.id}/assignments`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { locationIds: [locationA.id] }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
