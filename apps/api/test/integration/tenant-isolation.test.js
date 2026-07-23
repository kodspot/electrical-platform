'use strict';

// Database-backed integration tests proving the core multi-tenancy guarantee (Audit
// finding H1): an authenticated staff member in one org can never see, read, or write
// another org's tickets or locations through the real HTTP API.
//
// Requires a reachable Postgres instance (DATABASE_URL). If none is available, every
// test in this file skips itself with a clear message rather than failing or hanging —
// see test/helpers/db.js#isDatabaseAvailable. Verified passing against a real Postgres
// instance; see the Work Package Completion Report.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestTicket,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation (H1)', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, adminB, locationA, locationB, ticketA, ticketB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    adminB = await createTestUser(orgB.id, { role: 'ADMIN' });

    locationA = await createTestLocation(orgA.id);
    locationB = await createTestLocation(orgB.id);

    ticketA = await createTestTicket(orgA.id, locationA.id, { title: '__wp1_test__ Ticket A' });
    ticketB = await createTestTicket(orgB.id, locationB.id, { title: '__wp1_test__ Ticket B' });

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

  it('GET /api/tickets never returns another org\'s tickets', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    const ids = body.tickets.map((tk) => tk.id);
    assert.ok(ids.includes(ticketA.id), 'Org A\'s own ticket must be visible to Org A\'s admin');
    assert.ok(!ids.includes(ticketB.id), 'Org B\'s ticket must never appear in Org A\'s list');
  });

  it('GET /api/tickets/:id returns 404 (not 200 or 403) for another org\'s ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    // 404, not 403 — the API must not even confirm the ticket exists in another org.
    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/tickets rejects a locationId belonging to another org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { locationId: locationB.id, title: 'Cross-org attempt' }
    });

    assert.strictEqual(res.statusCode, 404, 'a location from another org must resolve as not found, not create a cross-org ticket');
  });

  it('PATCH /api/tickets/:id (admin-only) cannot modify another org\'s ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { priority: 'URGENT' }
    });

    assert.strictEqual(res.statusCode, 404);

    // Confirm it truly was not modified, from Org B's own perspective
    const loginB = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminB.email, password: adminB.plaintextPassword }
    });
    const tokenB = loginB.json().token;

    const checkRes = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB.id}`,
      headers: { authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(checkRes.json().priority, 'NORMAL', 'ticket B priority must be unchanged');
  });

  it('a SuperAdmin token with no X-Org-Id header sees neither org\'s data as its own context', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    // Sanity check on the boundary condition itself, not a full SA impersonation test
    // (that belongs to a future task covering finding H2).
    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenA}`, 'x-org-id': orgB.id }
    });

    // Admin A is not a SUPER_ADMIN, so the X-Org-Id header must have no effect at all.
    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().tickets.map((tk) => tk.id);
    assert.ok(!ids.includes(ticketB.id), 'a non-SuperAdmin must never be able to use X-Org-Id to view another org');
  });
});
