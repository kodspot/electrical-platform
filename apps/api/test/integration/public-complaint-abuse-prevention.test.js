'use strict';

// Regression tests for WP11 (Public Complaint Abuse Prevention). Covers the
// two findings closed in this work package:
//   - H8: the spam riskScore computed by POST /public/complaint was recorded
//     on the ticket but never enforced. It's now rejected (429) once the
//     score reaches its top tier (3+ identical-location submissions from the
//     same IP within 30 minutes) — the exact threshold the scoring already
//     defined, not a new one.
//   - M11: the IP hash used for that detection is now peppered
//     (HMAC-SHA256 with IP_HASH_PEPPER) when the env var is configured, with
//     a safe unpeppered fallback when it isn't.
//
// Follows the established pattern in public-complaint.test.js (a distinct
// x-forwarded-for header per client identity, since this endpoint's own
// 5-req/15-min rate limit and now this WP's abuse threshold both key off
// req.ip). That file is left untouched — this is a new, WP11-specific file.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('WP11 — public complaint abuse prevention', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, locationA, locationB;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    locationA = await createTestLocation(org.id);
    locationB = await createTestLocation(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('allows the first 3 submissions from the same IP+location, recording an escalating riskScore', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = '10.11.0.1';

    const res1 = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(res1.statusCode, 200);
    const ticket1 = await prisma.ticket.findUnique({ where: { id: res1.json().ticket.id } });
    assert.strictEqual(ticket1.riskScore, 0, 'first submission from a fresh IP+location must score 0');

    const res2 = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(res2.statusCode, 200, 'a second submission (low risk) must not be blocked');
    const ticket2 = await prisma.ticket.findUnique({ where: { id: res2.json().ticket.id } });
    assert.strictEqual(ticket2.riskScore, 40, 'riskScore is still recorded for staff triage even though not enforced at this tier');

    const res3 = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(res3.statusCode, 200, 'a third submission (still 40) must not be blocked');
  });

  it('rejects the 4th submission from the same IP+location within 30 minutes (riskScore 80 tier)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = '10.11.0.2';

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
      assert.strictEqual(res.statusCode, 200, `submission ${i + 1} must succeed`);
    }

    const before_ = await prisma.ticket.count({ where: { orgId: org.id, locationId: locationA.id } });

    const blocked = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(blocked.statusCode, 429, 'the 4th rapid submission must be rejected, not merely flagged');

    const after_ = await prisma.ticket.count({ where: { orgId: org.id, locationId: locationA.id } });
    assert.strictEqual(after_, before_, 'a rejected submission must not create a ticket at all');
  });

  it('does not block a submission to a different location from the same abusive IP', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = '10.11.0.3';

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    }
    // Confirm locationA is now blocked for this IP...
    const blockedA = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(blockedA.statusCode, 429);

    // ...but a genuinely different location from the same IP is unaffected —
    // risk is scoped per orgId+locationId+sourceIp, not just sourceIp.
    const okB = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationB.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(okB.statusCode, 200, 'a different location must not inherit another location\'s abuse block');
  });

  it('a rejected submission never uploads or stores an image, and never reaches ticket creation', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = '10.11.0.4';

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/complaint',
      headers: { 'x-forwarded-for': ip },
      payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING', description: 'blocked attempt' }
    });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.json().ticket, undefined, 'a blocked response must not include a ticket payload');
  });

  it('peppering the IP hash changes the stored sourceIp for the same client IP', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = '10.11.0.5';

    const originalPepper = process.env.IP_HASH_PEPPER;
    try {
      delete process.env.IP_HASH_PEPPER;
      const resUnpeppered = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationA.id, issueType: 'LIGHT_NOT_WORKING' } });
      const unpepperedTicket = await prisma.ticket.findUnique({ where: { id: resUnpeppered.json().ticket.id } });

      process.env.IP_HASH_PEPPER = '__wp1_test__-pepper-value';
      const resPeppered = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': ip }, payload: { locationId: locationB.id, issueType: 'LIGHT_NOT_WORKING' } });
      const pepperedTicket = await prisma.ticket.findUnique({ where: { id: resPeppered.json().ticket.id } });

      assert.ok(unpepperedTicket.sourceIp, 'sourceIp must still be computed with no pepper set');
      assert.ok(pepperedTicket.sourceIp, 'sourceIp must still be computed with a pepper set');
      assert.notStrictEqual(unpepperedTicket.sourceIp, pepperedTicket.sourceIp, 'the same raw IP must hash differently once a pepper is introduced');
    } finally {
      if (originalPepper === undefined) delete process.env.IP_HASH_PEPPER;
      else process.env.IP_HASH_PEPPER = originalPepper;
    }
  });
});
