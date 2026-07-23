'use strict';

// Database-backed integration tests proving worker-auth.js (routes/worker-auth.js) scopes
// a WORKER-authenticated session (JWT from POST /api/auth/worker-login, not admin login)
// correctly: a worker can never see or act on tickets outside their own org, AND — since
// worker ticket visibility is governed by location COVERAGE (WorkerAssignment via
// getWorkerCoverageLocationIds), not just orgId — a worker also cannot see tickets at an
// unassigned location within their OWN org.
//
// Follows the exact pattern of test/integration/tenant-isolation.test.js (WP1, H1), but
// authenticates via the worker JWT flow instead of admin/supervisor login.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestLocation,
  createTestWorker,
  createTestWorkerAssignment,
  createTestTicket,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — worker-auth.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, workerA, locationACovered, locationAUncovered, locationB;
  let ticketACovered, ticketAUncovered, ticketB, workerToken;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    locationACovered = await createTestLocation(orgA.id, { name: '__wp1_test__ Covered Location' });
    locationAUncovered = await createTestLocation(orgA.id, { name: '__wp1_test__ Uncovered Location' });
    locationB = await createTestLocation(orgB.id, { name: '__wp1_test__ Location B' });

    // pin must be exactly 6 digits to satisfy the worker-login zod schema — the
    // db helper's own default ('1234') is only 4 digits and would 400 on login.
    workerA = await createTestWorker(orgA.id, { name: '__wp1_test__ Worker A', pin: '482913' });
    await createTestWorkerAssignment(orgA.id, workerA.id, locationACovered.id);

    ticketACovered = await createTestTicket(orgA.id, locationACovered.id, { title: '__wp1_test__ Covered Ticket' });
    ticketAUncovered = await createTestTicket(orgA.id, locationAUncovered.id, { title: '__wp1_test__ Uncovered Ticket' });
    ticketB = await createTestTicket(orgB.id, locationB.id, { title: '__wp1_test__ Ticket B' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/worker-login',
      payload: { orgSlug: orgA.slug, employeeId: workerA.employeeId, pin: workerA.plaintextPin }
    });
    assert.strictEqual(loginRes.statusCode, 200, 'fixture worker login must succeed');
    workerToken = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('GET /api/worker/tickets only returns tickets within the worker\'s assigned coverage', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/worker/tickets',
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().tickets.map((tk) => tk.id);
    assert.ok(ids.includes(ticketACovered.id), 'a ticket at the worker\'s assigned location must be visible');
    assert.ok(!ids.includes(ticketAUncovered.id), 'a ticket at an unassigned location in the WORKER\'S OWN ORG must not be visible');
    assert.ok(!ids.includes(ticketB.id), 'a ticket in another org must never be visible');
  });

  it('GET /api/worker/tickets/:id returns 200 for a ticket within coverage', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/worker/tickets/${ticketACovered.id}`,
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 200);
  });

  it('GET /api/worker/tickets/:id returns 404 for another org\'s ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/worker/tickets/${ticketB.id}`,
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/worker/tickets/:id returns 404 for a same-org ticket outside the worker\'s coverage', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/worker/tickets/${ticketAUncovered.id}`,
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/worker/tickets/:id/pickup rejects another org\'s ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: `/api/worker/tickets/${ticketB.id}/pickup`,
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/worker/tickets/:id/resolve rejects another org\'s ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: `/api/worker/tickets/${ticketB.id}/resolve`,
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { note: 'trying to resolve a ticket that is not mine' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/worker/locations/qr/:code never resolves another org\'s QR code', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/worker/locations/qr/${locationB.qrCode}`,
      headers: { authorization: `Bearer ${workerToken}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
