'use strict';

/**
 * BUG-0006 — a fixed defect, encoded as a reproducible scenario + regression. [F14]
 */

const {
  createTestOrg, createTestLocation, createTestTicket, createTestWorker, createTestWorkerAssignment
} = require('../factories');

module.exports = {
  id: 'BUG-0006',
  title: 'Body-less POST/PATCH from the browser was rejected (electricians could not pick up tickets)',
  description: 'The browser helpers send Content-Type: application/json even with no body; the server rejected every such POST/PATCH with 400 FST_ERR_CTP_EMPTY_JSON_BODY before auth — breaking electrician Pick Up, alert acknowledge, AI insight generate, template duplicate, notification mark-read and the production-checks button.',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'Batch 2 e2e journey J4 (finding F14), fixed in C9',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-13',
  rootCause: 'public/js/app.js apiFetch/saFetch/elecFetch always set Content-Type: application/json, and Fastify\'s default JSON parser rejects an empty body. API tests used inject() without a content type, so they never saw it.',
  expectedBehavior: 'POST /api/worker/tickets/:id/pickup with Content-Type: application/json and an empty body succeeds (200) and moves the ticket to IN_PROGRESS.',
  brokenBehavior: '400 FST_ERR_CTP_EMPTY_JSON_BODY; the ticket stayed OPEN.',
  reproductionSteps: [
    'Create an org with a location, an electrician assigned to it, and an OPEN ticket there.',
    'As the electrician, POST /api/worker/tickets/:id/pickup with Content-Type: application/json and no body — exactly what the electrician app sends.',
    'Broken: 400 FST_ERR_CTP_EMPTY_JSON_BODY. Fixed: 200, status IN_PROGRESS.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id, { pin: '123456' });
    await createTestWorkerAssignment(org.id, worker.id, location.id);
    const ticket = await createTestTicket(org.id, location.id, { title: 'BUG-0006 ticket', status: 'OPEN' });
    return { org, worker, ticket };
  },

  async validate(ctx) {
    const { org, worker, ticket } = ctx['BUG-0006'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '123456' } });
    if (login.statusCode !== 200) return { ok: false, detail: `worker-login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/worker/tickets/${ticket.id}/pickup`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${login.json().token}` },
      payload: ''
    });
    if (res.statusCode !== 200) return { ok: false, detail: `browser-style pickup expected 200, got ${res.statusCode} ${res.body.slice(0, 80)}` };
    const stored = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id } });
    if (stored.status !== 'IN_PROGRESS') return { ok: false, detail: `expected IN_PROGRESS, got ${stored.status}` };
    return { ok: true, detail: 'browser-style empty JSON pickup accepted (200) and the ticket is IN_PROGRESS' };
  }
};
