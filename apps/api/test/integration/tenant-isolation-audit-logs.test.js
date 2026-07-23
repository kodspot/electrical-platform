'use strict';

// Database-backed integration tests proving audit-logs.js (routes/audit-logs.js)
// never leaks another org's AuditLog entries through the real HTTP API. Follows
// the exact pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// Note on the two route files in this batch with no dedicated tenant-isolation
// test file: health.js serves no tenant-scoped data at all (liveness/readiness
// checks only, no orgId anywhere), and images.js's upload/delete-adjacent access
// path is already covered indirectly — its org check compares the R2 key's
// embedded orgId against request.user.orgId directly (see routes/images.js
// line 37), and it operates on already org-scoped parent entities (tickets/
// assets) whose ownership checks are covered by those entities' own tests.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestAuditLog,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — audit-logs.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, logA, logB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    logA = await createTestAuditLog(orgA.id, { action: '__wp1_test___action_a', entityType: 'TestEntityA' });
    logB = await createTestAuditLog(orgB.id, { action: '__wp1_test___action_b', entityType: 'TestEntityB' });

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

  it('GET /api/audit-logs never returns another org\'s log entry', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    const ids = body.logs.map((l) => l.id);
    assert.ok(ids.includes(logA.id), 'Org A\'s own log entry must be visible');
    assert.ok(!ids.includes(logB.id), 'Org B\'s log entry must never appear in Org A\'s list');
  });

  it('GET /api/audit-logs/actions never surfaces another org\'s action type', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs/actions',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const actions = res.json();
    assert.ok(actions.includes('__wp1_test___action_a'), 'Org A\'s own action type must be visible');
    assert.ok(!actions.includes('__wp1_test___action_b'), 'Org B\'s action type must never appear');
  });

  it('GET /api/audit-logs/entity-types never surfaces another org\'s entity type', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs/entity-types',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const entityTypes = res.json();
    assert.ok(entityTypes.includes('TestEntityA'), 'Org A\'s own entity type must be visible');
    assert.ok(!entityTypes.includes('TestEntityB'), 'Org B\'s entity type must never appear');
  });
});
