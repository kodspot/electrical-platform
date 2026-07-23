'use strict';

// Database-backed integration tests proving asset-events.js (routes/asset-events.js)
// never leaks another org's AssetEvent records and rejects logging an event against a
// foreign-org assetId. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
//
// asset-events.js is gated by requireModule('asset'), so both fixture orgs are created
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
  createTestAssetEvent,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — asset-events.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, assetA, assetB, eventA, eventB, tokenA;

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

    eventA = await createTestAssetEvent(orgA.id, assetA.id, adminA.id, { summary: '__wp1_test__ Event A' });
    eventB = await createTestAssetEvent(orgB.id, assetB.id, adminB.id, { summary: '__wp1_test__ Event B' });

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

  it('GET /api/asset-events never returns another org\'s events', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/asset-events',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().events.map((e) => e.id);
    assert.ok(ids.includes(eventA.id), 'Org A\'s own event must be visible');
    assert.ok(!ids.includes(eventB.id), 'Org B\'s event must never appear in Org A\'s list');
  });

  it('GET /api/asset-events/:id returns 404 (not 200 or 403) for another org\'s event', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/asset-events/${eventB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/asset-events rejects logging an event against a foreign-org assetId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/asset-events',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        assetId: assetB.id,
        type: 'INSPECTED',
        summary: 'Cross-org event attempt'
      }
    });

    assert.strictEqual(res.statusCode, 404, 'an asset from another org must resolve as not found, not create a cross-org event');
  });

  it('GET /api/assets/:assetId/timeline rejects another org\'s assetId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/assets/${assetB.id}/timeline`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
