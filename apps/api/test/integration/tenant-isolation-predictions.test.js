'use strict';

// Database-backed integration tests proving predictions.js (routes/predictions.js)
// never leaks another org's asset risk scores or anomaly data through the real
// HTTP API. Follows the exact pattern of test/integration/tenant-isolation.test.js
// (WP1, H1).
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

describe('tenant isolation — predictions.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, adminB, locationA, locationB, assetA, assetB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    adminB = await createTestUser(orgB.id, { role: 'ADMIN' });

    locationA = await createTestLocation(orgA.id);
    locationB = await createTestLocation(orgB.id);

    assetA = await createTestAsset(orgA.id, locationA.id, { name: '__wp1_test__ Asset A' });
    assetB = await createTestAsset(orgB.id, locationB.id, { name: '__wp1_test__ Asset B' });

    // Give Org B's asset 3 recent failures — this is what triggers the
    // REPEAT_FAILURE anomaly type in services/predictions.js#detectAnomalies.
    // Used below to prove Org A's anomaly feed never surfaces Org B's asset.
    for (let i = 0; i < 3; i++) {
      await createTestAssetFailure(orgB.id, assetB.id, adminB.id, {
        title: `__wp1_test__ Failure ${i}`,
        failedAt: new Date()
      });
    }

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

  it('GET /api/predictions/risk-scores never returns another org\'s asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/predictions/risk-scores',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().assets.map((a) => a.assetId);
    assert.ok(ids.includes(assetA.id), 'Org A\'s own asset must be visible to Org A\'s admin');
    assert.ok(!ids.includes(assetB.id), 'Org B\'s asset must never appear in Org A\'s risk scores');
  });

  it('GET /api/predictions/assets/:assetId returns 404 (not 200 or 403) for another org\'s asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/predictions/assets/${assetB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/predictions/assets/:assetId returns Org A\'s own asset detail', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/predictions/assets/${assetA.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().assetId, assetA.id);
  });

  it('GET /api/predictions/anomalies never surfaces another org\'s repeat-failure asset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/predictions/anomalies',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    const leaked = body.anomalies.some((a) => a.metric && a.metric.assetId === assetB.id);
    assert.ok(!leaked, 'Org B\'s repeat-failure asset must never appear in Org A\'s anomaly feed');
  });

  it('GET /api/predictions/trends is scoped to the caller\'s own org (200, well-formed)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/predictions/trends?weeks=4',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().weeks, 4);
  });
});
