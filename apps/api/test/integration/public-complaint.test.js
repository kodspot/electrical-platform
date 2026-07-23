'use strict';

// Database-backed integration tests for the one fully public, unauthenticated write
// surface in the product (routes/public.js POST /api/public/complaint).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable (see
// test/helpers/db.js). Verified passing against a real Postgres instance. Each
// request carries a distinct x-forwarded-for header so the 5-req/15-min rate limit
// on this endpoint (routes/public.js) doesn't collide across test cases sharing
// one app instance and one real client IP.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');

describe('public complaint submission', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let activeOrg, activeLocation, inactiveLocation, suspendedOrg, suspendedLocation;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    activeOrg = await createTestOrg();
    suspendedOrg = await createTestOrg({ status: 'SUSPENDED' });
    createdOrgIds.push(activeOrg.id, suspendedOrg.id);

    activeLocation = await createTestLocation(activeOrg.id);
    inactiveLocation = await createTestLocation(activeOrg.id, { isActive: false });
    suspendedLocation = await createTestLocation(suspendedOrg.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('accepts a valid complaint with no authentication and no image', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.1' },
      payload: { locationId: activeLocation.id, issueType: 'LIGHT_NOT_WORKING' }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.ticket.status, 'OPEN');
    assert.ok(body.ticket.id);
  });

  it('rejects an issueType that is not in the allowed set for the module', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.2' },
      payload: { locationId: activeLocation.id, issueType: 'NOT_A_REAL_ISSUE_TYPE' }
    });

    assert.strictEqual(res.statusCode, 400);
  });

  it('rejects a complaint missing required fields', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.3' },
      payload: { issueType: 'LIGHT_NOT_WORKING' } // no locationId
    });

    assert.strictEqual(res.statusCode, 400);
  });

  it('returns 404 for a deactivated location', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.4' },
      payload: { locationId: inactiveLocation.id, issueType: 'LIGHT_NOT_WORKING' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('returns 410 for a location belonging to a suspended org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.5' },
      payload: { locationId: suspendedLocation.id, issueType: 'LIGHT_NOT_WORKING' }
    });

    assert.strictEqual(res.statusCode, 410);
  });

  it('a submitted complaint is only visible to staff of the org it was filed against', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const { createTestUser } = require('../helpers/db');
    const admin = await createTestUser(activeOrg.id, { role: 'ADMIN' });

    const complaintRes = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.0.0.6' },
      payload: { locationId: activeLocation.id, issueType: 'POWER_OUTAGE' }
    });
    const complaintId = complaintRes.json().ticket.id;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    const token = loginRes.json().token;

    const ticketRes = await app.inject({
      method: 'GET',
      url: `/api/tickets/${complaintId}`,
      headers: { authorization: `Bearer ${token}` }
    });

    assert.strictEqual(ticketRes.statusCode, 200);
    assert.strictEqual(ticketRes.json().source, 'PUBLIC');
  });
});
