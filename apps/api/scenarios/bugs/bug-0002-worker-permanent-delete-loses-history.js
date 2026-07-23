'use strict';

/**
 * BUG-0002 — a fixed defect, encoded as a reproducible scenario + regression. [platform-M4]
 */

const { createTestOrg, createTestUser, createTestLocation, createTestWorker, createTestElectricalInspection } = require('../factories');

module.exports = {
  id: 'BUG-0002',
  title: 'Permanent-deleting a worker silently dropped their inspection history',
  description: 'DELETE /workers/:id/permanent disconnected a worker from their inspection records and deleted, instead of blocking like the supervisor equivalent.',
  module: 'ele',
  category: 'worker-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Technical-debt cleanup — delete-guard parity ([WP17], finding L4)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-07-21',
  rootCause: 'The worker permanent-delete route disconnected inspection links then deleted; the supervisor route blocked with 409. The two structurally-equivalent actions behaved differently, losing worker↔inspection history with no warning.',
  expectedBehavior: 'DELETE /workers/:id/permanent on a deactivated worker with inspection history is rejected with 409, preserving the association.',
  brokenBehavior: 'The worker was deleted and its inspection associations silently removed.',
  reproductionSteps: [
    'Create an org with an admin, a supervisor, and a deactivated worker linked to an inspection.',
    'As the admin, DELETE /api/workers/:id/permanent.',
    'Broken: 200 and the worker is deleted. Fixed: 409 and the worker remains.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id, { isActive: false });
    const inspection = await createTestElectricalInspection(org.id, location.id, supervisor.id, {
      workers: { connect: [{ id: worker.id }] }
    });
    return { org, admin, worker, inspection };
  },

  async validate(ctx) {
    const { admin, worker } = ctx['BUG-0002'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/workers/${worker.id}/permanent`,
      headers: { authorization: `Bearer ${token}` }
    });
    if (res.statusCode !== 409) return { ok: false, detail: `expected 409 (blocked), got ${res.statusCode}` };
    const still = await ctx.prisma.worker.findUnique({ where: { id: worker.id } });
    if (!still) return { ok: false, detail: 'worker was deleted despite inspection history' };
    return { ok: true, detail: 'permanent-delete of a worker with inspection history correctly blocked (409); worker preserved' };
  }
};
