'use strict';

/**
 * BUG-0016 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0016',
  title: 'A reopened public ticket could still be closed by the guest\'s old review link, or by the review auto-close',
  description: 'When an admin moved a resolved public ticket back to an active status (PATCH /tickets/:id), the resolution fields were cleared but the pending guest review was not. The old review link still CONFIRMED the resolution — closing a ticket that was being worked on again — and once the 30-minute review window passed, the lazy auto-close on GET /tickets closed it too.',
  module: 'complaints',
  category: 'ticket-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (ticket lifecycle, every role)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'tickets.js PATCH cleared resolvedAt/verifiedAt and friends but not reviewToken/reviewStatus/reviewExpiresAt; autoCloseExpiredReviews closed any PUBLIC ticket with a PENDING review, whatever its status.',
  expectedBehavior: 'Moving a ticket back to an active status withdraws a pending guest review (the link answers 404), and the auto-close only ever closes RESOLVED tickets.',
  brokenBehavior: 'The guest\'s CONFIRM answered 200 and the reopened ticket became CLOSED.',
  reproductionSteps: [
    'Create an org with an admin and a PUBLIC ticket that is RESOLVED with a PENDING guest review.',
    'As the admin, PATCH /api/tickets/:id { status: "IN_PROGRESS" }.',
    'As the guest, POST /api/public/review/:token { action: "CONFIRM" }.',
    'Broken: 200 and the ticket is CLOSED. Fixed: 404 and the ticket stays IN_PROGRESS.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const reviewToken = crypto.randomBytes(32).toString('hex');
    const ticket = await createTestTicket(org.id, location.id, {
      status: 'RESOLVED', source: 'PUBLIC', resolvedAt: new Date(), resolvedNote: 'Fixed',
      reviewToken, reviewStatus: 'PENDING', reviewExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    return { org, admin, ticket, reviewToken };
  },

  async validate(ctx) {
    const { admin, ticket, reviewToken } = ctx['BUG-0016'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.16' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const patch = await ctx.app.inject({ method: 'PATCH', url: `/api/tickets/${ticket.id}`, headers: { authorization: `Bearer ${login.json().token}` }, payload: { status: 'IN_PROGRESS' } });
    if (patch.statusCode !== 200) return { ok: false, detail: `PATCH expected 200, got ${patch.statusCode}` };
    const confirm = await ctx.app.inject({ method: 'POST', url: `/api/public/review/${reviewToken}`, headers: { 'x-forwarded-for': '10.94.1.16' }, payload: { action: 'CONFIRM' } });
    const now = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id } });
    if (confirm.statusCode === 200 || now.status !== 'IN_PROGRESS') {
      return { ok: false, detail: `the old review link answered ${confirm.statusCode} and the ticket is ${now.status}` };
    }
    return { ok: true, detail: `the old link answers ${confirm.statusCode}; the reopened ticket stays IN_PROGRESS` };
  }
};
