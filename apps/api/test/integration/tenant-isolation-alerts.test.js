'use strict';

// Database-backed integration tests proving alerts.js (routes/alerts.js) never leaks or
// lets an admin acknowledge/mutate another org's AlertRule or Alert rows through the
// real HTTP API. Follows the exact pattern of test/integration/tenant-isolation.test.js
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
  createTestAlertRule,
  createTestAlert,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — alerts.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, ruleA, ruleB, alertA, alertB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    ruleA = await createTestAlertRule(orgA.id, { name: '__wp1_test__ Rule A' });
    ruleB = await createTestAlertRule(orgB.id, { name: '__wp1_test__ Rule B' });

    alertA = await createTestAlert(orgA.id, { title: '__wp1_test__ Alert A', ruleId: ruleA.id });
    alertB = await createTestAlert(orgB.id, { title: '__wp1_test__ Alert B', ruleId: ruleB.id });

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

  it('GET /api/alert-rules never returns another org\'s rules', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/alert-rules',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().rules.map((r) => r.id);
    assert.ok(ids.includes(ruleA.id), 'Org A\'s own rule must be visible');
    assert.ok(!ids.includes(ruleB.id), 'Org B\'s rule must never appear in Org A\'s list');
  });

  it('GET /api/alert-rules/:id returns 404 (not 200 or 403) for another org\'s rule', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/alert-rules/${ruleB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/alert-rules/:id cannot modify another org\'s rule', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/alert-rules/${ruleB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { isActive: false }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/alert-rules/:id cannot delete another org\'s rule', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/alert-rules/${ruleB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/alerts never returns another org\'s alerts', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().alerts.map((a) => a.id);
    assert.ok(ids.includes(alertA.id), 'Org A\'s own alert must be visible');
    assert.ok(!ids.includes(alertB.id), 'Org B\'s alert must never appear in Org A\'s list');
  });

  it('GET /api/alerts/:id returns 404 (not 200 or 403) for another org\'s alert', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/alerts/${alertB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/alerts/:id/acknowledge cannot acknowledge another org\'s alert', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/alerts/${alertB.id}/acknowledge`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/alerts/acknowledge-all only affects the caller\'s own org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/alerts/acknowledge-all',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);

    // Org B's alert must remain untouched
    const { prisma } = require('../../src/lib/prisma');
    const refreshedB = await prisma.alert.findUnique({ where: { id: alertB.id } });
    assert.strictEqual(refreshedB.acknowledged, false, 'Org B\'s alert must not be acknowledged by Org A\'s bulk action');
  });
});
