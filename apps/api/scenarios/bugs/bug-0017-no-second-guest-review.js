'use strict';

/**
 * BUG-0017 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0017',
  title: 'After a guest rejected a fix, the next verified fix never got a guest review',
  description: 'POST /tickets/:id/verify issued a guest review link only when the ticket had no review token at all. After a guest rejected the first resolution, the ticket kept its spent (REJECTED) token, so verifying the second fix issued no new link: the supervisor was handed the old one, which says "already reviewed", and the ticket stayed RESOLVED instead of going to the guest.',
  module: 'complaints',
  category: 'ticket-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (ticket lifecycle, every role)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'tickets.js verify tested `!ticket.reviewToken` instead of whether a review is currently pending.',
  expectedBehavior: 'Verifying a public ticket issues a fresh review link unless a review is already pending.',
  brokenBehavior: 'The response carried the old, already-rejected link; the guest could not review the second fix.',
  reproductionSteps: [
    'Create a PUBLIC ticket in RESOLVED_PENDING_VERIFY whose earlier review the guest REJECTED.',
    'As the admin, POST /api/tickets/:id/verify.',
    'Broken: reviewUrl is the old token ("already reviewed"). Fixed: a new token whose review page is pending.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const oldToken = crypto.randomBytes(32).toString('hex');
    const ticket = await createTestTicket(org.id, location.id, {
      status: 'RESOLVED_PENDING_VERIFY', source: 'PUBLIC', resolvedAt: new Date(), resolvedNote: 'Second fix',
      reviewToken: oldToken, reviewStatus: 'REJECTED', reviewNote: 'Still broken', reviewedAt: new Date(), reviewExpiresAt: new Date(Date.now() - 60 * 1000)
    });
    return { org, admin, ticket, oldToken };
  },

  async validate(ctx) {
    const { admin, ticket, oldToken } = ctx['BUG-0017'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.17' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'POST', url: `/api/tickets/${ticket.id}/verify`, headers: { authorization: `Bearer ${login.json().token}` }, payload: {} });
    if (res.statusCode !== 200) return { ok: false, detail: `verify expected 200, got ${res.statusCode}` };
    const token = String(res.json().reviewUrl || '').split('/').pop();
    if (!token || token === oldToken) return { ok: false, detail: 'no new review link was issued' };
    const page = await ctx.app.inject({ method: 'GET', url: `/api/public/review/${token}`, headers: { 'x-forwarded-for': '10.94.1.17' } });
    if (page.statusCode !== 200 || page.json().status !== 'pending') return { ok: false, detail: `the new review page is ${page.statusCode} ${page.body.slice(0, 60)}` };
    return { ok: true, detail: 'a fresh, pending review link is issued' };
  }
};
