'use strict';

// Database-backed integration tests proving electrical.js (routes/electrical.js) never
// leaks another org's ElectricalInspection records and rejects submitting an inspection
// against a foreign-org locationId or templateId. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
//
// POST /electrical-inspections is normally submitted as multipart/form-data (the route
// unwraps `{ value }`-shaped multipart fields via a local `fieldValue()` helper), but
// since @fastify/multipart (attachFieldsToBody: true) only intercepts multipart
// requests, a plain JSON body — which fieldValue() also accepts unwrapped — exercises
// the exact same validation path without needing a real file upload.
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
  createTestInspectionTemplate,
  createTestElectricalInspection,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — electrical.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, supervisorA, locationA, locationB, workerA;
  let templateB, inspectionA, inspectionB, tokenSupervisorA, tokenAdminA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    supervisorA = await createTestUser(orgA.id, { role: 'SUPERVISOR' });

    locationA = await createTestLocation(orgA.id);
    locationB = await createTestLocation(orgB.id);

    workerA = await createTestWorker(orgA.id);

    templateB = await createTestInspectionTemplate(orgB.id);

    inspectionA = await createTestElectricalInspection(orgA.id, locationA.id, supervisorA.id, {
      notes: '__wp1_test__ Inspection A'
    });
    const supervisorB = await createTestUser(orgB.id, { role: 'SUPERVISOR' });
    inspectionB = await createTestElectricalInspection(orgB.id, locationB.id, supervisorB.id, {
      notes: '__wp1_test__ Inspection B'
    });

    const loginSupervisorA = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: supervisorA.email, password: supervisorA.plaintextPassword }
    });
    assert.strictEqual(loginSupervisorA.statusCode, 200, 'fixture login for Supervisor A must succeed');
    tokenSupervisorA = loginSupervisorA.json().token;

    const loginAdminA = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminA.email, password: adminA.plaintextPassword }
    });
    assert.strictEqual(loginAdminA.statusCode, 200, 'fixture login for Admin A must succeed');
    tokenAdminA = loginAdminA.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('POST /api/electrical-inspections rejects a locationId belonging to another org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/electrical-inspections',
      headers: { authorization: `Bearer ${tokenSupervisorA}` },
      payload: {
        locationId: locationB.id,
        workerIds: [workerA.id],
        shift: 'GENERAL',
        items: [{ checkType: 'LIGHTING', status: 'OK' }]
      }
    });

    assert.strictEqual(res.statusCode, 404, 'a location from another org must resolve as not found');
  });

  it('POST /api/electrical-inspections rejects a templateId belonging to another org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/electrical-inspections',
      headers: { authorization: `Bearer ${tokenSupervisorA}` },
      payload: {
        locationId: locationA.id,
        templateId: templateB.id,
        workerIds: [workerA.id],
        shift: 'GENERAL',
        items: [{ checkType: 'LIGHTING', status: 'OK' }]
      }
    });

    assert.strictEqual(res.statusCode, 400, 'a template from another org must not resolve for Org A\'s submission');
  });

  it('GET /api/electrical-inspections never returns another org\'s inspections', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/electrical-inspections',
      headers: { authorization: `Bearer ${tokenAdminA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().records.map((r) => r.id);
    assert.ok(ids.includes(inspectionA.id), 'Org A\'s own inspection must be visible');
    assert.ok(!ids.includes(inspectionB.id), 'Org B\'s inspection must never appear in Org A\'s list');
  });

  it('GET /api/electrical-inspections/:id returns 404 (not 200 or 403) for another org\'s inspection', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/electrical-inspections/${inspectionB.id}`,
      headers: { authorization: `Bearer ${tokenAdminA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('PATCH /api/electrical-inspections/:id/flag cannot flag another org\'s inspection', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/electrical-inspections/${inspectionB.id}/flag`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { reason: 'cross-org flag attempt' }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
