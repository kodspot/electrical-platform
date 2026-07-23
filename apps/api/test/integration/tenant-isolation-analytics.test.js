'use strict';

// Database-backed integration tests proving analytics.js (routes/analytics.js)
// never lets one org's aggregate counts or drill-down lists include another
// org's tickets/locations. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
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
  createTestTicket,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — analytics.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, locationA, locationB, ticketA, ticketB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

    locationA = await createTestLocation(orgA.id, { name: '__wp1_test__ Location A' });
    locationB = await createTestLocation(orgB.id, { name: '__wp1_test__ Location B' });

    // Default status OPEN — falls inside ACTIVE_TICKET_STATUSES, so both
    // tickets are counted by /analytics/dashboard's openTickets aggregate
    // unless properly scoped per-org.
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

  it('GET /api/analytics/dashboard openTickets only counts Org A\'s own open tickets', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/dashboard',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    // Org A has exactly one open ticket (ticketA). If Org B's ticket leaked
    // into the aggregate, this count would be 2.
    assert.strictEqual(res.json().openTickets, 1, 'openTickets must not include Org B\'s ticket');
  });

  it('GET /api/analytics/report ticketStats never includes another org\'s ticket or location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/report',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    // Only Org A's ticket (created "today") should be counted in the default
    // (today-only) reporting period.
    assert.strictEqual(body.ticketStats.total, 1, 'ticketStats.total must not include Org B\'s ticket');
    assert.strictEqual(body.summary.totalLocations, 1, 'totalLocations must not include Org B\'s location');

    const topLocationNames = body.ticketStats.topLocations.map((l) => l.name);
    assert.ok(
      !topLocationNames.some((n) => n.includes(locationB.name)),
      'Org B\'s location must never appear in Org A\'s ticket location breakdown'
    );

    const breakdownIds = body.locationBreakdown.map((l) => l.id);
    assert.ok(!breakdownIds.includes(locationB.id), 'Org B\'s location must never appear in locationBreakdown');
  });

  it('GET /api/analytics/location/:id/history returns 404 (not 200 or 403) for another org\'s location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/location/${locationB.id}/history`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/analytics/location/:id/history for Org A\'s own location never lists another org\'s active tickets', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/analytics/location/${locationA.id}/history`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ticketIds = res.json().activeTickets.map((tk) => tk.id);
    assert.ok(ticketIds.includes(ticketA.id), 'Org A\'s own active ticket must be visible');
    assert.ok(!ticketIds.includes(ticketB.id), 'Org B\'s ticket must never appear');
  });
});
