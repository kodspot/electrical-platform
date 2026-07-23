'use strict';

// Database-backed integration tests proving locations.js (routes/locations.js) never
// leaks or lets an admin mutate another org's Location rows through the real HTTP API.
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
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — locations.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, locationA, locationB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    locationA = await createTestLocation(orgA.id, { name: '__wp1_test__ Location A' });
    locationB = await createTestLocation(orgB.id, { name: '__wp1_test__ Location B' });

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

  it('GET /api/locations never returns another org\'s locations', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/locations',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().map((l) => l.id);
    assert.ok(ids.includes(locationA.id), 'Org A\'s own location must be visible');
    assert.ok(!ids.includes(locationB.id), 'Org B\'s location must never appear in Org A\'s list');
  });

  it('GET /api/locations/:id returns 404 (not 200 or 403) for another org\'s location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/locations/${locationB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/locations/:id cannot modify another org\'s location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/locations/${locationB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Name' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/locations/:id cannot deactivate another org\'s location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/locations/${locationB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/locations/qr/:code never resolves another org\'s QR code', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/locations/qr/${locationB.qrCode}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
