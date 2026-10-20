'use strict';

/**
 * BUG-0021 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestAsset } = require('../factories');

module.exports = {
  id: 'BUG-0021',
  title: 'Clearing an optional field in the asset, location or alert-rule edit form was not saved',
  description: 'The edit forms sent `undefined` for a field the admin emptied, so the key was dropped from the request and the server — for which an omitted key means "unchanged" — kept the old value: an asset\'s make, model, serial, rated capacity, description, install/warranty/maintenance dates, maintenance cycle and purchase cost; a location\'s notes, and moving it back to "None (Top Level)"; an alert rule\'s description. The page said "updated" and the old value came back. The asset API also refused null for its two numeric fields, so they could not be cleared at all.',
  module: 'asset',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (every button and form)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'admin-assets.html, admin-locations.html and admin-alerts.html built the PATCH body with `value || undefined` (and `if (parentId)`); assets.js updateAssetSchema was createAssetSchema.partial(), whose numbers are not nullable.',
  expectedBehavior: 'On edit, a cleared field is sent empty ("" or null) and stored as empty; an omitted field is still unchanged.',
  brokenBehavior: 'The cleared value reappeared after saving; PATCH /assets/:id with purchaseCost: null answered 400.',
  reproductionSteps: [
    'Create an asset with a make, a warranty date and a purchase cost.',
    'As the admin, PATCH /api/assets/:id { make: "", warrantyExpiry: "", purchaseCost: null } (what the fixed form sends).',
    'Broken: 400 (purchaseCost null). Fixed: 200 and all three are empty. The browser side is e2e/tests/forms.spec.js (BUG-0021 ×3).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    const org = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const asset = await createTestAsset(org.id, location.id, { make: 'Schneider', warrantyExpiry: new Date('2030-01-31'), purchaseCost: 12500 });
    return { org, admin, asset };
  },

  async validate(ctx) {
    const { admin, asset } = ctx['BUG-0021'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.21' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/assets/${asset.id}`, headers: { authorization: `Bearer ${login.json().token}` }, payload: { make: '', warrantyExpiry: '', purchaseCost: null } });
    if (res.statusCode !== 200) return { ok: false, detail: `the clear payload answered ${res.statusCode} ${res.body.slice(0, 80)}` };
    const now = await ctx.prisma.asset.findUnique({ where: { id: asset.id } });
    if (now.make !== null || now.warrantyExpiry !== null || now.purchaseCost !== null) return { ok: false, detail: 'a cleared field kept its value' };
    return { ok: true, detail: 'cleared fields are stored as empty' };
  }
};
