'use strict';

// Database-backed integration tests for superadmin.js (routes/superadmin.js).
//
// Different semantics from every other route file in this batch: SUPER_ADMIN is
// *intentionally* cross-org (per the WP7 manual audit). So this file proves two
// different things instead of one leak boundary:
//   (a) a non-SUPER_ADMIN (regular ADMIN) hitting any /superadmin/* route gets
//       403, never data — the privilege boundary itself.
//   (b) a genuine SUPER_ADMIN can see both orgs, and a per-org drill-down
//       endpoint for Org A's id returns only Org A's data, never Org B's —
//       i.e. the cross-org privilege doesn't also mean "can't tell orgs apart."
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { prisma } = require('../../src/lib/prisma');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestWorker,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — superadmin.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, superAdmin, workerA, workerB, tokenA, tokenSA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    // SUPER_ADMIN users are not tied to any org (orgId: null), matching how
    // routes/auth.js#bootstrap creates them — so they're outside the
    // cleanupTestOrgs cascade and are deleted explicitly in after() below.
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });

    workerA = await createTestWorker(orgA.id, { name: '__wp1_test__ Worker A' });
    workerB = await createTestWorker(orgB.id, { name: '__wp1_test__ Worker B' });

    const loginA = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminA.email, password: adminA.plaintextPassword }
    });
    assert.strictEqual(loginA.statusCode, 200, 'fixture login for Admin A must succeed');
    tokenA = loginA.json().token;

    const loginSA = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: superAdmin.email, password: superAdmin.plaintextPassword }
    });
    assert.strictEqual(loginSA.statusCode, 200, 'fixture login for SuperAdmin must succeed');
    tokenSA = loginSA.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('a regular ADMIN hitting /superadmin/organizations gets 403, not data', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/superadmin/organizations',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 403);
  });

  it('a regular ADMIN hitting a superadmin drill-down route also gets 403', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/superadmin/organizations/${orgA.id}/workers`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 403);
  });

  it('a genuine SUPER_ADMIN sees both orgs in GET /superadmin/organizations', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/superadmin/organizations',
      headers: { authorization: `Bearer ${tokenSA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().map((o) => o.id);
    assert.ok(ids.includes(orgA.id), 'SuperAdmin must see Org A');
    assert.ok(ids.includes(orgB.id), 'SuperAdmin must see Org B');
  });

  it('SUPER_ADMIN drill-down for Org A\'s workers returns only Org A\'s workers, never Org B\'s', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/superadmin/organizations/${orgA.id}/workers`,
      headers: { authorization: `Bearer ${tokenSA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().map((w) => w.id);
    assert.ok(ids.includes(workerA.id), 'must include Org A\'s own worker');
    assert.ok(!ids.includes(workerB.id), 'drill-down for Org A must never include Org B\'s worker');
  });

  it('SUPER_ADMIN drill-down for Org B\'s workers returns only Org B\'s workers, never Org A\'s', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/superadmin/organizations/${orgB.id}/workers`,
      headers: { authorization: `Bearer ${tokenSA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().map((w) => w.id);
    assert.ok(ids.includes(workerB.id), 'must include Org B\'s own worker');
    assert.ok(!ids.includes(workerA.id), 'drill-down for Org B must never include Org A\'s worker');
  });
});
