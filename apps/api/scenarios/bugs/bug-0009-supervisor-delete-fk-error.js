'use strict';

/**
 * BUG-0009 — a fixed defect, encoded as a reproducible scenario + regression. [F13]
 */

const { createTestOrg, createTestUser, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0009',
  title: 'Permanently deleting a supervisor who created tickets failed with a server error',
  description: 'DELETE /supervisors/:id/permanent only checked inspection history. Ticket.createdById (and four other references to a user) are ON DELETE RESTRICT in the database, so deleting a supervisor who had created a ticket, marked attendance, been on a duty roster or logged an asset event/failure failed on the foreign key — a 500 instead of a clear 409.',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'F13 schema-drift diagnosis (2026-10-14), fixed in PR #9',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-14',
  rootCause: 'The route pre-checked only electricalInspection; the schema declared Ticket.createdBy without onDelete (Prisma default SetNull) while the migrations created RESTRICT, so the gap was invisible from the schema.',
  expectedBehavior: 'A deactivated supervisor referenced by any RESTRICT foreign key is refused with 409 and the counts; one with no history is deleted (200).',
  brokenBehavior: '500 (foreign-key violation from prisma.user.delete).',
  reproductionSteps: [
    'Create an org with an admin, a deactivated supervisor, and a ticket created by that supervisor.',
    'As the admin, DELETE /api/supervisors/:id/permanent.',
    'Broken: 500. Fixed: 409 { ticketsCreated: 1 } and the supervisor remains.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR', isActive: false });
    const location = await createTestLocation(org.id);
    await createTestTicket(org.id, location.id, { createdById: supervisor.id });
    return { org, admin, supervisor };
  },

  async validate(ctx) {
    const { admin, supervisor } = ctx['BUG-0009'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.9' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/supervisors/${supervisor.id}/permanent`, headers: { authorization: `Bearer ${login.json().token}` } });
    if (res.statusCode !== 409) return { ok: false, detail: `expected 409, got ${res.statusCode} ${res.body.slice(0, 80)}` };
    const kept = await ctx.prisma.user.findUnique({ where: { id: supervisor.id } });
    if (!kept) return { ok: false, detail: 'the supervisor was deleted' };
    return { ok: true, detail: 'blocked with 409 and the supervisor is kept' };
  }
};
