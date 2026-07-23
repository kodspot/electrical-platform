'use strict';

// Database-backed integration tests proving complaint-categories.js
// (routes/complaint-categories.js) never leaks or lets an admin mutate another
// org's ComplaintCategory rows through the real HTTP API. Follows the exact
// pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// Note: this route file has no GET-by-id endpoint (only list, PATCH, DELETE by
// id), so the cross-org id-based checks below cover PATCH and DELETE only.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestComplaintCategory,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — complaint-categories.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, categoryA, categoryB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    categoryA = await createTestComplaintCategory(orgA.id, { name: '__wp1_test__ Category A' });
    categoryB = await createTestComplaintCategory(orgB.id, { name: '__wp1_test__ Category B' });

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

  it('GET /api/complaint-categories never returns another org\'s categories', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/complaint-categories',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().categories.map((c) => c.id);
    assert.ok(ids.includes(categoryA.id), 'Org A\'s own category must be visible');
    assert.ok(!ids.includes(categoryB.id), 'Org B\'s category must never appear in Org A\'s list');
  });

  it('PATCH /api/complaint-categories/:id returns 404 (not 200 or 403) for another org\'s category', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/complaint-categories/${categoryB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Category' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/complaint-categories/:id returns 404 (not 200 or 403) for another org\'s category', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/complaint-categories/${categoryB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
