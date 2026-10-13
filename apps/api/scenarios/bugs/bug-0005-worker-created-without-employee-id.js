'use strict';

/**
 * BUG-0005 — a fixed defect, encoded as a reproducible scenario + regression. [WP-H F8]
 */

const { createTestOrg, createTestUser } = require('../factories');

module.exports = {
  id: 'BUG-0005',
  title: 'A worker could be created without an employeeId and then never log in',
  description: 'POST /api/workers accepted a worker with no employeeId, but worker-login identifies workers by employeeId + PIN — so that worker could never sign in. PATCH could also clear an existing employeeId.',
  module: 'ele',
  category: 'worker-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'QA-1 characterisation finding F8 (docs/testing/COVERAGE_MATRIX.md), fixed in [WP-H]',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-13',
  rootCause: 'employeeId was optional in the create schemas (workers.js, superadmin.js) and clearable in the PATCH schemas, while POST /auth/worker-login requires it.',
  expectedBehavior: 'Creating a worker without a non-empty employeeId is rejected with 400; a worker created with one can have a PIN set and log in.',
  brokenBehavior: 'The worker was created (200) with employeeId null and could not log in.',
  reproductionSteps: [
    'Create an org with an admin.',
    'As the admin, POST /api/workers with a name and no employeeId.',
    'Broken: 200 and a worker who can never log in. Fixed: 400.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    return { org, admin };
  },

  async validate(ctx) {
    const { org, admin } = ctx['BUG-0005'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const headers = { authorization: `Bearer ${token}` };
    const missing = await ctx.app.inject({ method: 'POST', url: '/api/workers', headers, payload: { name: `BUG-0005 no id ${Date.now()}` } });
    if (missing.statusCode !== 400) return { ok: false, detail: `create without employeeId expected 400, got ${missing.statusCode}` };

    const employeeId = `BUG-0005-${Date.now()}`;
    const created = await ctx.app.inject({ method: 'POST', url: '/api/workers', headers, payload: { name: `BUG-0005 ok ${Date.now()}`, employeeId } });
    if (created.statusCode !== 200) return { ok: false, detail: `create with employeeId expected 200, got ${created.statusCode}` };
    const pin = await ctx.app.inject({ method: 'PATCH', url: `/api/workers/${created.json().id}/pin`, headers, payload: { pin: '123456' } });
    if (pin.statusCode !== 200) return { ok: false, detail: `set PIN expected 200, got ${pin.statusCode}` };
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId, pin: '123456' } });
    if (login.statusCode !== 200) return { ok: false, detail: `worker-login expected 200, got ${login.statusCode}` };
    return { ok: true, detail: 'missing employeeId rejected (400); create → set PIN → worker-login succeeds' };
  }
};
