'use strict';

/**
 * BUG-0015 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestWorker, createTestWorkerAssignment } = require('../factories');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

module.exports = {
  id: 'BUG-0015',
  title: 'An electrician could "resolve" a ticket that a supervisor had already verified, sending it back to verification',
  description: 'POST /worker/tickets/:id/resolve refused only CLOSED and CANCELLED tickets. A verified (RESOLVED) ticket, or one already waiting for verification, could be resolved again: a verified ticket dropped back to RESOLVED_PENDING_VERIFY and its proof photo was replaced. The electrician app only offers "Resolve With Photo" on open and in-progress tickets; the server did not enforce it.',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (ticket lifecycle, every role)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'worker-auth.js resolve checked status against CLOSED/CANCELLED only, not against the active statuses (OPEN, ACKNOWLEDGED, ASSIGNED, IN_PROGRESS, ON_HOLD) the UI allows.',
  expectedBehavior: 'Resolving a RESOLVED or RESOLVED_PENDING_VERIFY ticket answers 400 and leaves the ticket unchanged; resolving straight from OPEN stays allowed.',
  brokenBehavior: '200: a verified ticket became RESOLVED_PENDING_VERIFY again, with the new photo.',
  reproductionSteps: [
    'Create an org, a location, an electrician covering it, and a RESOLVED (verified) ticket there.',
    'As the electrician, POST /api/worker/tickets/:id/resolve with a proof photo.',
    'Broken: 200 and status RESOLVED_PENDING_VERIFY. Fixed: 400 and status still RESOLVED.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id, { pin: '415263' });
    await createTestWorkerAssignment(org.id, worker.id, location.id);
    const ticket = await createTestTicket(org.id, location.id, { status: 'RESOLVED', assignedToId: supervisor.id, verifiedAt: new Date(), verifiedById: supervisor.id });
    return { org, worker, ticket };
  },

  async validate(ctx) {
    const { org, worker, ticket } = ctx['BUG-0015'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': '10.94.0.15' }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    if (login.statusCode !== 200) return { ok: false, detail: `worker login expected 200, got ${login.statusCode}` };
    const boundary = '----bug0015' + crypto.randomUUID().replace(/-/g, '');
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="proof.png"\r\nContent-Type: image/png\r\n\r\n`), PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/worker/tickets/${ticket.id}/resolve`, payload,
      headers: { authorization: `Bearer ${login.json().token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }
    });
    // The refusal must come from the status rule, before any upload: without a storage driver
    // the broken code also answers 400 (the upload fails), so the message is what proves it.
    if (res.statusCode !== 400 || !/already resolved/i.test(res.body)) return { ok: false, detail: `expected 400 "already resolved", got ${res.statusCode} ${res.body.slice(0, 80)}` };
    const now = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id } });
    if (now.status !== 'RESOLVED') return { ok: false, detail: `the verified ticket became ${now.status}` };
    return { ok: true, detail: 'refused with 400; the verified ticket stays RESOLVED' };
  }
};
