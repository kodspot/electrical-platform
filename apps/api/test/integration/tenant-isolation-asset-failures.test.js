'use strict';

// Database-backed integration tests proving asset-failures.js (routes/asset-failures.js)
// never leaks or lets staff mutate another org's AssetFailure rows through the real HTTP
// API. Follows the exact pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// asset-failures.js is gated by requireModule('asset'), so both fixture orgs are created
// with the 'asset' module enabled (createTestOrg defaults to ['ele'] only).
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
  createTestAssetFailure,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — asset-failures.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, assetA, assetB, failureA, failureB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    orgB = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    const adminB = await createTestUser(orgB.id, { role: 'ADMIN' });

    const locationA = await createTestLocation(orgA.id);
    const locationB = await createTestLocation(orgB.id);

    assetA = await createTestAsset(orgA.id, locationA.id, { name: '__wp1_test__ Asset A' });
    assetB = await createTestAsset(orgB.id, locationB.id, { name: '__wp1_test__ Asset B' });

    failureA = await createTestAssetFailure(orgA.id, assetA.id, adminA.id, { title: '__wp1_test__ Failure A' });
    failureB = await createTestAssetFailure(orgB.id, assetB.id, adminB.id, { title: '__wp1_test__ Failure B' });

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

  it('GET /api/asset-failures never returns another org\'s failures', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/asset-failures',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().failures.map((f) => f.id);
    assert.ok(ids.includes(failureA.id), 'Org A\'s own failure must be visible');
    assert.ok(!ids.includes(failureB.id), 'Org B\'s failure must never appear in Org A\'s list');
  });

  it('GET /api/asset-failures/:id returns 404 (not 200 or 403) for another org\'s failure', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/asset-failures/${failureB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/asset-failures/:id cannot modify another org\'s failure', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/asset-failures/${failureB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { status: 'ACKNOWLEDGED' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/asset-failures rejects reporting a failure against a foreign-org assetId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/asset-failures',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        assetId: assetB.id,
        title: 'Cross-org failure attempt'
      }
    });

    assert.strictEqual(res.statusCode, 404, 'an asset from another org must resolve as not found, not create a cross-org failure');
  });
});
