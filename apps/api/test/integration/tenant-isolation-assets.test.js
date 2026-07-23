'use strict';

// Database-backed integration tests proving assets.js (routes/assets.js) never leaks or
// lets an admin mutate another org's Asset rows through the real HTTP API. Follows the
// exact pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// assets.js is gated by requireModule('asset'), so both fixture orgs are created with
// the 'asset' module enabled (createTestOrg defaults to ['ele'] only).
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
  createTestAsset,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — assets.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, locationA, locationB, assetA, assetB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    orgB = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    locationA = await createTestLocation(orgA.id);
    locationB = await createTestLocation(orgB.id);

    assetA = await createTestAsset(orgA.id, locationA.id, { name: '__wp1_test__ Asset A' });
    assetB = await createTestAsset(orgB.id, locationB.id, { name: '__wp1_test__ Asset B' });

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

  it('GET /api/assets never returns another org\'s assets', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/assets',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().assets.map((a) => a.id);
    assert.ok(ids.includes(assetA.id), 'Org A\'s own asset must be visible');
    assert.ok(!ids.includes(assetB.id), 'Org B\'s asset must never appear in Org A\'s list');
  });

  it('GET /api/assets/:id returns 404 (not 200 or 403) for another org\'s asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${assetB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/assets/:id cannot modify another org\'s asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${assetB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Asset' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/assets rejects a locationId belonging to another org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        assetCode: '__wp1_test__-cross-org',
        name: 'Cross-org attempt',
        category: 'Panel Board',
        locationId: locationB.id
      }
    });

    assert.strictEqual(res.statusCode, 404, 'a location from another org must resolve as not found, not create a cross-org asset');
  });

  it('DELETE /api/assets/:id cannot delete/decommission another org\'s asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/assets/${assetB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
