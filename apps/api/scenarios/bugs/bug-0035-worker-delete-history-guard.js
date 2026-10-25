'use strict';

/**
 * BUG-0035 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestWorker } = require('../factories');

module.exports = {
  id: 'BUG-0035',
  title: 'Permanently deleting an electrician who was on a duty roster failed with a 500; attendance history was silently erased',
  description: 'DELETE /api/workers/:id/permanent checked only inspection history. DutyRosterWorker references Worker with ON DELETE RESTRICT, so for anyone ever put on a roster the delete failed with a foreign-key error (500). Attendance records and the worker\'s link to tickets they resolved cascade, so for those workers the delete went through and silently erased that history — against the rule that history-bearing deletes are refused (409, [WP17]). Found by the 2026-10 product and architecture review (PAR-10/20).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/20)',
  dateIntroduced: '2026-03-22 (duty rosters)',
  dateFixed: '2026-10-25',
  rootCause: 'The [WP17] dependency check counted inspections only; rosters, attendance and resolved tickets were added later without extending it.',
  expectedBehavior: 'The delete is refused with 409 and counts of every history that names the worker; nothing is deleted.',
  brokenBehavior: 'A worker on a roster: 500 "Database error". A worker with attendance records: deleted, attendance gone.',
  reproductionSteps: [
    'Deactivate an electrician who is on a duty roster.',
    'DELETE /api/workers/:id/permanent as the org admin.',
    'Broken: 500. Fixed: 409 with dutyRosters: 1.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/permanent-delete-parity.test.js',

  async apply() {
    const { prisma } = require('../../src/lib/prisma');
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id, { isActive: false });
    const roster = await prisma.dutyRoster.create({ data: { orgId: org.id, date: new Date('2026-10-03'), shift: 'MORNING', locationId: location.id, supervisorId: admin.id, workers: { create: [{ workerId: worker.id }] } } });
    return { org, admin, worker, roster };
  },

  async validate(ctx) {
    const { admin, worker, roster } = ctx['BUG-0035'];
    try {
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.35' }, payload: { email: admin.email, password: admin.plaintextPassword } });
      if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
      const res = await ctx.app.inject({ method: 'DELETE', url: `/api/workers/${worker.id}/permanent`, headers: { authorization: `Bearer ${login.json().token}` } });
      if (res.statusCode !== 409) return { ok: false, detail: `expected 409, got ${res.statusCode}` };
      return { ok: true, detail: 'refused with 409; the roster still names the worker' };
    } finally {
      // The org cleanup cannot delete a worker a roster still names (RESTRICT): remove it first.
      await ctx.prisma.dutyRoster.deleteMany({ where: { id: roster.id } });
    }
  }
};
