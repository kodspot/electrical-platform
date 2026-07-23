'use strict';

// Database-backed regression test for pages.js (routes/pages.js) `validateOrg()`.
//
// This locks in a real fix made in this Work Package: validateOrg() previously
// only rejected orgs with status === 'DELETED', silently letting a SUSPENDED
// org's landing page (and its /api/org/:slug resolver) stay reachable. It now
// requires status === 'ACTIVE' (see src/routes/pages.js, validateOrg). This test
// would have failed before that fix (a SUSPENDED org would have returned 200,
// not 404).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — pages.js (validateOrg SUSPENDED regression)', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let activeOrg, suspendedOrg;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    activeOrg = await createTestOrg();
    suspendedOrg = await createTestOrg({ status: 'SUSPENDED' });
    createdOrgIds.push(activeOrg.id, suspendedOrg.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('GET /:orgSlug returns 404 for a SUSPENDED org (not the org landing page)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/${suspendedOrg.slug}`
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /:orgSlug serves the landing page for an ACTIVE org (sanity check, not a 404)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/${activeOrg.slug}`
    });

    assert.notStrictEqual(res.statusCode, 404);
  });

  it('GET /api/org/:slug returns 404 for a SUSPENDED org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/org/${suspendedOrg.slug}`
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/org/:slug resolves normally for an ACTIVE org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/org/${activeOrg.slug}`
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().id, activeOrg.id);
  });
});
