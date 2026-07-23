'use strict';

/**
 * BUG-0001 — a fixed defect, encoded as a reproducible scenario + regression. [platform-M4]
 */

const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0001',
  title: 'Admin could set a ticket to RESOLVED_PENDING_VERIFY directly',
  description: 'The generic admin ticket editor accepted a worker-only status, producing a "pending verification" ticket with no resolution evidence.',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Engineering audit — state-transition consistency ([WP10], Charter §8.2)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-07-19',
  rootCause: 'PATCH /tickets/:id accepted any EDITABLE status, including RESOLVED_PENDING_VERIFY — a machine-only state that should only be produced by a worker submitting resolution evidence.',
  expectedBehavior: 'PATCH /tickets/:id with status=RESOLVED_PENDING_VERIFY is rejected with 400.',
  brokenBehavior: 'The PATCH succeeded (200) and moved the ticket into pending-verification with no evidence attached.',
  reproductionSteps: [
    'Create an org with an admin and an OPEN ticket.',
    'As the admin, PATCH the ticket with { status: "RESOLVED_PENDING_VERIFY" }.',
    'Broken: 200 and status changes. Fixed: 400 (rejected).'
  ],
  // Built from factories in an isolated org (parallel-safe, like every other test). The
  // runner also supports M3 scenario dependencies for bugs that need composed state.
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const ticket = await createTestTicket(org.id, location.id, { title: 'BUG-0001 ticket', status: 'OPEN' });
    return { org, admin, ticket };
  },

  async validate(ctx) {
    const { admin, ticket } = ctx['BUG-0001'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const res = await ctx.app.inject({
      method: 'PATCH', url: `/api/tickets/${ticket.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'RESOLVED_PENDING_VERIFY' }
    });
    if (res.statusCode !== 400) return { ok: false, detail: `expected 400 (rejected), got ${res.statusCode}` };
    return { ok: true, detail: 'admin PATCH to RESOLVED_PENDING_VERIFY correctly rejected (400)' };
  }
};
