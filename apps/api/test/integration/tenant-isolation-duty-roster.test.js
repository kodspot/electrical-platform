'use strict';

// Database-backed integration tests proving duty-roster.js (routes/duty-roster.js) never
// leaks another org's DutyRoster records and rejects reading/mutating a foreign-org
// roster by id — including PUT /duty-roster/:id/workers, which was just hardened in
// src to filter by orgId; this file locks that fix in end-to-end via HTTP.
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
  createTestDutyRoster,
  cleanupTestOrgs
} = require('../helpers/db');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

describe('tenant isolation — duty-roster.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, supervisorB, locationA, workerA, rosterA, rosterB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    supervisorB = await createTestUser(orgB.id, { role: 'SUPERVISOR' });

    locationA = await createTestLocation(orgA.id);
    const locationB = await createTestLocation(orgB.id);

    workerA = await createTestWorker(orgA.id, { name: '__wp1_test__ Worker A' });

    rosterA = await createTestDutyRoster(orgA.id, locationA.id, adminA.id, {
      date: new Date(`${todayStr()}T00:00:00Z`),
      shift: 'MORNING'
    });
    rosterB = await createTestDutyRoster(orgB.id, locationB.id, supervisorB.id, {
      date: new Date(`${todayStr()}T00:00:00Z`),
      shift: 'MORNING'
    });

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

  it('GET /api/duty-roster never returns another org\'s rosters', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/duty-roster?date=${todayStr()}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().rosters.map((r) => r.id);
    assert.ok(ids.includes(rosterA.id), 'Org A\'s own roster must be visible');
    assert.ok(!ids.includes(rosterB.id), 'Org B\'s roster must never appear in Org A\'s list');
  });

  it('PATCH /api/duty-roster/:id returns 404 for another org\'s roster', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/duty-roster/${rosterB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { locationId: locationA.id }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PUT /api/duty-roster/:id/workers returns 404 for another org\'s roster (regression: orgId-scoped fix)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/duty-roster/${rosterB.id}/workers`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { workerIds: [workerA.id] }
    });

    assert.strictEqual(res.statusCode, 404, 'assigning workers to another org\'s roster must be rejected as not found');
  });

  it('DELETE /api/duty-roster/:id cannot delete another org\'s roster', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/duty-roster/${rosterB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);

    // Confirm Org B's roster still exists, from Org B's own perspective
    const supervisorLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: supervisorB.email, password: supervisorB.plaintextPassword }
    });
    assert.strictEqual(supervisorLogin.statusCode, 200);
    const tokenB = supervisorLogin.json().token;

    const checkRes = await app.inject({
      method: 'GET',
      url: `/api/duty-roster/mine?date=${todayStr()}&shift=MORNING`,
      headers: { authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(checkRes.statusCode, 200);
    assert.strictEqual(checkRes.json().id, rosterB.id, 'Org B\'s roster must be untouched by Org A\'s failed delete attempt');
  });
});
