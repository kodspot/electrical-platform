'use strict';

/**
 * BUG-0042 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0042',
  title: 'A ticket the guest rejected was open again but still carried its resolution and verification times',
  description: 'POST /api/public/review/:token with REJECT reopened the ticket (OPEN, back to the pool) but left resolvedAt, verifiedAt, verifiedById and verifyNote set. Every other reopen clears them ([WP10]). Analytics counts any ticket with resolvedAt as resolved, so a rejected, open ticket counted as resolved with a stale resolution time. The photo and note stay on purpose (BUG-0026). Found by the 2026-10 product and architecture review (PAR-10/55).',
  module: 'complaints',
  category: 'ticket-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/55)',
  dateIntroduced: '2026-10-20 (BUG-0026 kept the resolution on purpose; the times came with it)',
  dateFixed: '2026-10-25',
  rootCause: 'The REJECT update cleared the assignee and electricians but not the resolution and verification timestamps.',
  expectedBehavior: 'After a guest rejection the ticket is OPEN with resolvedAt, verifiedAt, verifiedById and verifyNote null; its photo and the guest\'s note stay.',
  brokenBehavior: 'OPEN, with resolvedAt and verifiedAt from the rejected fix.',
  reproductionSteps: [
    'Verify a public ticket so a guest review opens.',
    'POST /api/public/review/:token with { action: "REJECT" }.',
    'Broken: resolvedAt and verifiedAt still set. Fixed: both null.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const token = crypto.randomBytes(32).toString('hex');
    const ticket = await createTestTicket(org.id, location.id, {
      source: 'PUBLIC', status: 'RESOLVED', resolvedAt: new Date(), verifiedAt: new Date(), verifiedById: supervisor.id, verifyNote: 'ok',
      reviewToken: token, reviewStatus: 'PENDING', reviewExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    return { org, ticket, token };
  },

  async validate(ctx) {
    const { ticket, token } = ctx['BUG-0042'];
    const res = await ctx.app.inject({ method: 'POST', url: `/api/public/review/${token}`, headers: { 'x-forwarded-for': '10.94.0.42' }, payload: { action: 'REJECT', note: 'Still broken' } });
    if (res.statusCode !== 200) return { ok: false, detail: `reject answered ${res.statusCode}` };
    const now = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id } });
    const stale = ['resolvedAt', 'verifiedAt', 'verifiedById', 'verifyNote'].filter((k) => now[k] !== null);
    if (now.status !== 'OPEN' || stale.length) return { ok: false, detail: `status ${now.status}; still set: ${stale.join(', ')}` };
    return { ok: true, detail: 'the rejected ticket is open with no resolution or verification time' };
  }
};
