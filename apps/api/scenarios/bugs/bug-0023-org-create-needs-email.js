'use strict';

/**
 * BUG-0023 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestUser } = require('../factories');

module.exports = {
  id: 'BUG-0023',
  title: 'A super-admin could not create an organization without entering an email',
  description: 'The "New Organization" form sends an empty Email field as "". POST /api/superadmin/organizations validated email as `z.string().email().optional()`, which refuses "", so every organization created without an email failed with 400 "Validation failed" (the edit route already accepted "").',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (super-admin forms)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'superadmin.js create schema lacked `.or(z.literal(\'\'))` on email, unlike the PATCH schema.',
  expectedBehavior: 'An empty email is accepted and stored as no email; an invalid email is still refused.',
  brokenBehavior: '400 Validation failed (email: Invalid email).',
  reproductionSteps: [
    'As a super-admin, POST /api/superadmin/organizations with { name, slug, type, enabledModules: ["ele"], phone: "", email: "", address: "" }.',
    'Broken: 400. Fixed: 200 and email is null.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/superadmin-org-form.test.js',

  async apply() {
    const sa = await createTestUser(null, { role: 'SUPER_ADMIN' });
    return { sa };
  },

  async validate(ctx) {
    const { sa } = ctx['BUG-0023'];
    const suffix = crypto.randomUUID().slice(0, 8);
    try {
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.23' }, payload: { email: sa.email, password: sa.plaintextPassword } });
      if (login.statusCode !== 200) return { ok: false, detail: `super-admin login expected 200, got ${login.statusCode}` };
      const res = await ctx.app.inject({
        method: 'POST', url: '/api/superadmin/organizations', headers: { authorization: `Bearer ${login.json().token}` },
        payload: { name: `__wp1_test__ BUG-0023 ${suffix}`, slug: `wp1-bug-0023-${suffix}`, type: 'HOSPITAL', enabledModules: ['ele'], phone: '', email: '', address: '' }
      });
      if (res.statusCode !== 200) return { ok: false, detail: `expected 200, got ${res.statusCode} ${res.body.slice(0, 80)}` };
      const org = res.json();
      ctx['BUG-0023'].org = org; // cleaned up by the regression test with the other orgs
      if (org.email !== null) return { ok: false, detail: `email stored as ${JSON.stringify(org.email)}` };
      return { ok: true, detail: 'created; the empty email is stored as null' };
    } finally {
      await ctx.prisma.user.deleteMany({ where: { id: sa.id } });
    }
  }
};
