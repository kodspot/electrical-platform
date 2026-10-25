'use strict';

/**
 * BUG-0049 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation } = require('../factories');

module.exports = {
  id: 'BUG-0049',
  title: 'An asset purchase cost of 0 was stored as "unknown"',
  description: 'routes/assets.js stored `data.purchaseCost || null` on create and edit, so a cost of 0 — a donated or free asset — became null. Found by the 2026-10 product and architecture review (PAR-10/52).',
  module: 'asset',
  category: 'admin-workflow',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/52)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: '`|| null` treats 0 as missing; `?? null` keeps it.',
  expectedBehavior: 'purchaseCost 0 is stored as 0; null still clears it.',
  brokenBehavior: 'purchaseCost null after saving 0.',
  reproductionSteps: [
    'POST /api/assets with purchaseCost: 0.',
    'Read the asset.',
    'Broken: purchaseCost null. Fixed: 0.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/admin-forms-api.test.js',

  async apply() {
    const org = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    return { org, admin, location };
  },

  async validate(ctx) {
    const { admin, location } = ctx['BUG-0049'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/assets', headers: { authorization: `Bearer ${token}` },
      payload: { assetCode: `__wp1_test__-S49-${Date.now()}`, name: '__wp1_test__ Donated meter', category: 'Meter', locationId: location.id, purchaseCost: 0 }
    });
    if (res.statusCode !== 201) return { ok: false, detail: `create answered ${res.statusCode}` };
    const asset = await ctx.prisma.asset.findUnique({ where: { id: res.json().id } });
    if (asset.purchaseCost !== 0) return { ok: false, detail: `a cost of 0 was stored as ${asset.purchaseCost}` };
    return { ok: true, detail: 'a purchase cost of 0 is kept' };
  }
};
