'use strict';

// Database-backed integration tests proving templates.js (routes/templates.js) never
// leaks or lets an admin mutate another org's InspectionTemplate rows through the real
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
  createTestInspectionTemplate,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — templates.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, templateA, templateB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    templateA = await createTestInspectionTemplate(orgA.id, { name: '__wp1_test__ Template A' });
    templateB = await createTestInspectionTemplate(orgB.id, { name: '__wp1_test__ Template B' });

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

  it('GET /api/inspection-templates never returns another org\'s templates', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/inspection-templates',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().map((tpl) => tpl.id);
    assert.ok(ids.includes(templateA.id), 'Org A\'s own template must be visible');
    assert.ok(!ids.includes(templateB.id), 'Org B\'s template must never appear in Org A\'s list');
  });

  it('GET /api/inspection-templates/:id returns 404 (not 200 or 403) for another org\'s template', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/inspection-templates/${templateB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/inspection-templates/:id cannot modify another org\'s template', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/inspection-templates/${templateB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Hijacked Template' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/inspection-templates/:id cannot delete another org\'s template', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/inspection-templates/${templateB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/inspection-templates/:id/duplicate cannot duplicate another org\'s template', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: `/api/inspection-templates/${templateB.id}/duplicate`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
