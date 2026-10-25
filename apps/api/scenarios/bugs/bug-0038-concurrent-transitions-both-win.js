'use strict';

/**
 * BUG-0038 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0038',
  title: 'Two people acting on one ticket at once both "succeeded" — the last write won',
  description: 'Every ticket transition read the ticket, checked its status, then updated it by id alone. Two requests at the same moment both passed the check: a fix was verified AND sent back (verify 200, reopen 200), verified twice (two audit rows, two notifications), or picked up by two supervisors. The same held for an electrician\'s resolve and the guest\'s review. Found by the 2026-10 product and architecture review (PAR-10/05).',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/05)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'Read-check-write without a condition on the write; nothing stopped the second write after the first changed the status.',
  expectedBehavior: 'Each transition writes only if the status is still the one it checked (updateTicketIfUnchanged); the loser answers 409 (or 400 once the change is visible). The admin\'s generic edit stays an explicit override.',
  brokenBehavior: 'Two concurrent verifies of one ticket both answered 200.',
  reproductionSteps: [
    'Create a ticket waiting for verification, assigned to a supervisor.',
    'Send POST /api/tickets/:id/verify as that supervisor and as an admin at the same moment.',
    'Broken: both 200. Fixed: exactly one 200.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-concurrency.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const tickets = [];
    for (let i = 0; i < 4; i++) tickets.push(await createTestTicket(org.id, location.id, { status: 'RESOLVED_PENDING_VERIFY', assignedToId: supervisor.id, resolvedAt: new Date() }));
    return { org, admin, supervisor, tickets };
  },

  async validate(ctx) {
    const { admin, supervisor, tickets } = ctx['BUG-0038'];
    const login = async (u, ip) => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { email: u.email, password: u.plaintextPassword } });
      return res.statusCode === 200 ? { authorization: `Bearer ${res.json().token}` } : null;
    };
    const a = await login(admin, '10.94.0.38');
    const s = await login(supervisor, '10.94.1.38');
    if (!a || !s) return { ok: false, detail: 'fixture logins failed' };
    for (const t of tickets) {
      const results = await Promise.all([
        ctx.app.inject({ method: 'POST', url: `/api/tickets/${t.id}/verify`, headers: s, payload: {} }),
        ctx.app.inject({ method: 'POST', url: `/api/tickets/${t.id}/verify`, headers: a, payload: {} })
      ]);
      const wins = results.filter((r) => r.statusCode === 200).length;
      if (wins !== 1) return { ok: false, detail: `two concurrent verifies: ${results.map((r) => r.statusCode).join(', ')}` };
    }
    return { ok: true, detail: 'one of two concurrent verifies wins, every time' };
  }
};
