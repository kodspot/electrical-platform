'use strict';

/**
 * BUG-0026 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestLocation, createTestTicket, createTestWorker, createTestWorkerAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0026',
  title: 'After a guest rejected a fix, the electrician who did it saw the ticket as "Done" and could not pick it up again',
  description: 'POST /api/public/review/:token with REJECT reopened the ticket (OPEN, unassigned) but left the resolving electricians connected to it. The worker pool excludes tickets the electrician is connected to, and the app shows a connected OPEN ticket with neither Pick Up nor Resolve, only "✓ Done": the electrician who knew the job could not take it back, and nobody told them the guest said it was not fixed.',
  module: 'complaints',
  category: 'ticket-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (ticket lifecycle, every role)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'public.js REJECT updated status/assignee/review fields only; the supervisor\'s /reopen already clears resolvedWorkers for this reason.',
  expectedBehavior: 'A guest rejection disconnects the resolving electricians (the ticket is back in their pool) and notifies them with the guest\'s note; the guest\'s verdict and note stay on the ticket.',
  brokenBehavior: 'The ticket was missing from the electrician\'s pool and showed "Done" in their app; no notification.',
  reproductionSteps: [
    'Create a PUBLIC ticket, RESOLVED by an electrician, with a pending guest review.',
    'As the guest, POST /api/public/review/:token { action: "REJECT", note }.',
    'Broken: the electrician is still in resolvedWorkers and has no notification. Fixed: disconnected, and a ticket_review_rejected notification with the note.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, worker.id, location.id);
    const reviewToken = crypto.randomBytes(32).toString('hex');
    const ticket = await createTestTicket(org.id, location.id, {
      status: 'RESOLVED', source: 'PUBLIC', resolvedAt: new Date(), resolvedNote: 'Replaced the tube',
      resolvedWorkers: { connect: [{ id: worker.id }] },
      reviewToken, reviewStatus: 'PENDING', reviewExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    return { org, worker, ticket, reviewToken };
  },

  async validate(ctx) {
    const { worker, ticket, reviewToken } = ctx['BUG-0026'];
    const res = await ctx.app.inject({ method: 'POST', url: `/api/public/review/${reviewToken}`, headers: { 'x-forwarded-for': '10.94.0.26' }, payload: { action: 'REJECT', note: 'Still dark' } });
    if (res.statusCode !== 200) return { ok: false, detail: `REJECT answered ${res.statusCode}` };
    const now = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id }, include: { resolvedWorkers: { select: { id: true } } } });
    if (now.resolvedWorkers.length) return { ok: false, detail: 'the electrician is still connected to the rejected ticket' };
    let told = null;
    for (let i = 0; i < 40 && !told; i++) {
      told = await ctx.prisma.notification.findFirst({ where: { workerId: worker.id, entityId: ticket.id, type: 'ticket_review_rejected' } });
      if (!told) await new Promise((r) => setTimeout(r, 50));
    }
    if (!told || !/Still dark/.test(told.body || '')) return { ok: false, detail: 'the electrician was not told (with the guest\'s note)' };
    return { ok: true, detail: 'disconnected and told, with the guest\'s note' };
  }
};
