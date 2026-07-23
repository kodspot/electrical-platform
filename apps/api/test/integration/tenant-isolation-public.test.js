'use strict';

// Database-backed integration tests proving public.js (routes/public.js) — the
// one fully unauthenticated route file — derives Ticket.orgId strictly from the
// server-resolved Location, never from anything client-supplied, and that the
// review-token flow has no fallback/prefix-matching behavior that could let a
// token minted for one org's ticket reach another org's ticket.
//
// See also test/integration/public-complaint.test.js, which covers the general
// complaint-submission validation surface (missing fields, inactive location,
// suspended org, etc.) — this file is scoped specifically to the tenant
// boundary. Each request below carries a distinct x-forwarded-for header so the
// rate limits on these endpoints (routes/public.js) don't collide across test
// cases sharing one app instance and one real client IP (see index.js
// `trustProxy: true`).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { prisma } = require('../../src/lib/prisma');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — public.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, locationA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    locationA = await createTestLocation(orgA.id, { name: '__wp1_test__ Location A' });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('POST /api/public/complaint creates a Ticket whose orgId is the location\'s own org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.1.0.1' },
      payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' }
    });

    assert.strictEqual(res.statusCode, 200);
    const ticketId = res.json().ticket.id;

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { orgId: true } });
    assert.strictEqual(ticket.orgId, orgA.id, 'ticket.orgId must equal the org that owns the location, not any other value');
  });

  it('POST /api/public/complaint ignores a client-supplied orgId field in the body', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.1.0.2' },
      payload: { locationId: locationA.id, issueType: 'POWER_OUTAGE', orgId: orgB.id }
    });

    assert.strictEqual(res.statusCode, 200);
    const ticketId = res.json().ticket.id;

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { orgId: true } });
    assert.strictEqual(ticket.orgId, orgA.id, 'a smuggled orgId field in the request body must never override the server-resolved org');
    assert.notStrictEqual(ticket.orgId, orgB.id);
  });

  it('GET /api/public/review/:token returns 404 for a well-formed but nonexistent token (no prefix/fallback matching)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const fakeToken = 'a'.repeat(64); // correct length, matches no real reviewToken

    const res = await app.inject({
      method: 'GET',
      url: `/api/public/review/${fakeToken}`,
      headers: { 'x-forwarded-for': '10.1.0.3' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/public/review/:token returns 404 for a malformed (wrong-length) token', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/public/review/not-a-real-token',
      headers: { 'x-forwarded-for': '10.1.0.4' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/public/review/:token returns 404 for a garbage token instead of acting on any ticket', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const fakeToken = 'b'.repeat(64);

    const res = await app.inject({
      method: 'POST',
      url: `/api/public/review/${fakeToken}`,
      headers: { 'x-forwarded-for': '10.1.0.5' },
      payload: { action: 'CONFIRM' }
    });

    assert.strictEqual(res.statusCode, 404);
  });
});
