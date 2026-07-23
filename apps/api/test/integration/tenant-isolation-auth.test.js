'use strict';

// Database-backed integration tests proving auth.js (routes/auth.js) resolves
// the ambiguous-email, multi-org login path (POST /api/auth/login when the same
// email exists as a User in more than one org) to the genuinely correct org and
// account — never a cross-org/cross-account mix-up. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — auth.js (ambiguous-email multi-org login)', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, sharedEmail;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    sharedEmail = `__wp1_test__-shared-${randomUUID().slice(0, 8)}@example.test`;

    // Same email, two different orgs, two different (deliberately distinct)
    // passwords — the distinct passwords let the tests below prove the login
    // resolves to the actually-matching account, not just "a" matching one.
    await createTestUser(orgA.id, { email: sharedEmail, password: 'OrgAPass123', role: 'ADMIN' });
    await createTestUser(orgB.id, { email: sharedEmail, password: 'OrgBPass123', role: 'ADMIN' });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('login with a shared email and no orgId/orgSlug returns 400 listing both orgs, not a silent pick', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: sharedEmail, password: 'OrgAPass123' }
    });

    assert.strictEqual(res.statusCode, 400);
    const orgIds = res.json().organizations.map((o) => o.orgId);
    assert.ok(orgIds.includes(orgA.id) && orgIds.includes(orgB.id), 'must list both candidate orgs');
  });

  it('login with orgId=Org A resolves to Org A\'s own account and context', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: sharedEmail, password: 'OrgAPass123', orgId: orgA.id }
    });

    assert.strictEqual(loginRes.statusCode, 200);
    assert.strictEqual(loginRes.json().user.orgId, orgA.id);
    const token = loginRes.json().token;

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    assert.strictEqual(meRes.statusCode, 200);
    assert.strictEqual(meRes.json().orgId, orgA.id, 'token must carry Org A\'s context, not Org B\'s');
    assert.strictEqual(meRes.json().org.id, orgA.id);
  });

  it('login with orgId=Org B resolves to Org B\'s own account and context', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: sharedEmail, password: 'OrgBPass123', orgId: orgB.id }
    });

    assert.strictEqual(loginRes.statusCode, 200);
    assert.strictEqual(loginRes.json().user.orgId, orgB.id);
    const token = loginRes.json().token;

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    assert.strictEqual(meRes.statusCode, 200);
    assert.strictEqual(meRes.json().orgId, orgB.id, 'token must carry Org B\'s context, not Org A\'s');
  });

  it('login with orgId=Org B but Org A\'s password fails — never falls back to a cross-account match', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: sharedEmail, password: 'OrgAPass123', orgId: orgB.id }
    });

    assert.strictEqual(res.statusCode, 401, 'Org A\'s password must not authenticate Org B\'s account, even with the same email');
  });

  it('login with orgSlug=Org A\'s slug resolves the same way as orgId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: sharedEmail, password: 'OrgAPass123', orgSlug: orgA.slug }
    });

    assert.strictEqual(loginRes.statusCode, 200);
    assert.strictEqual(loginRes.json().user.orgId, orgA.id);
  });
});
