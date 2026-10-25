'use strict';

/**
 * BUG-0052 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { createTestOrg, createTestUser, createTestWorker } = require('../factories');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');

module.exports = {
  id: 'BUG-0052',
  title: 'Nobody could change their own password or PIN while signed in',
  description: 'PATCH /auth/password (admin, supervisor) and PATCH /auth/worker-pin (electrician) had no screen in the app; the only way to a new password or PIN was an administrator, or a reset email. Found by the 2026-10 product and architecture review (PAR-10/26).',
  module: 'ele',
  category: 'account-recovery',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/26)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The endpoints were built without a screen.',
  expectedBehavior: 'The profile modal has "Change password" (staff) or "Change PIN" (electrician); the session goes on with the token the server returns; a wrong current PIN does not sign the electrician out.',
  brokenBehavior: 'No way to change a password or PIN from the app.',
  reproductionSteps: [
    'Sign in; open the user menu → Profile.',
    'Broken: only Close. Fixed: Change password / Change PIN → current, new, confirm → "changed".',
    'Browser test: e2e/tests/forms.spec.js (BUG-0052).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN', password: 'OldPass123' });
    const worker = await createTestWorker(org.id, { pin: '246802' });
    return { org, admin, worker };
  },

  async validate(ctx) {
    const src = fs.readFileSync(APP_JS, 'utf8');
    for (const needle of ["path: '/auth/password'", "path: '/auth/worker-pin'", 'id="profileChangeSecret"', 'await fetch(API + target.path']) {
      if (!src.includes(needle)) return { ok: false, detail: `app.js: ${needle} is missing` };
    }

    // What the screen relies on: the change answers a token that keeps this session going.
    const { org, admin, worker } = ctx['BUG-0052'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const change = await ctx.app.inject({ method: 'PATCH', url: '/api/auth/password', headers: { authorization: `Bearer ${token}` }, payload: { currentPassword: 'OldPass123', newPassword: 'NewPass456' } });
    if (change.statusCode !== 200 || !change.json().token) return { ok: false, detail: `password change answered ${change.statusCode} without a token` };
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${change.json().token}` } });
    if (me.statusCode !== 200) return { ok: false, detail: `the returned token answered ${me.statusCode}` };

    const wl = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': '10.88.52.1' }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '246802' } });
    if (wl.statusCode !== 200) return { ok: false, detail: `worker login answered ${wl.statusCode}` };
    const pin = await ctx.app.inject({ method: 'PATCH', url: '/api/auth/worker-pin', headers: { authorization: `Bearer ${wl.json().token}` }, payload: { currentPin: '246802', newPin: '135791' } });
    if (pin.statusCode !== 200 || !pin.json().token) return { ok: false, detail: `PIN change answered ${pin.statusCode} without a token` };
    const wme = await ctx.app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${pin.json().token}` } });
    if (wme.statusCode !== 200) return { ok: false, detail: `the returned worker token answered ${wme.statusCode}` };
    return { ok: true, detail: 'the profile changes a password or PIN; the session goes on' };
  }
};
