'use strict';

/**
 * BUG-0051 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { createTestOrg } = require('../factories');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
// [sign-in page, the request page its "Forgot …?" link opens]
const LINKS = [
  ['admin-login.html', '/reset-password'],
  ['supervisor-login.html', '/reset-password'],
  ['electrician-login.html', '/worker-reset-pin']
];
// [request page script, the endpoint it calls]
const REQUESTS = [
  ['js/reset-password.js', "fetch('/api/auth/forgot-password'"],
  ['js/worker-reset-pin.js', "fetch('/api/auth/worker-forgot-pin'"]
];

module.exports = {
  id: 'BUG-0051',
  title: 'No sign-in page let anyone ask for a password or PIN reset; the super-admin "Run one-time setup" link was dead',
  description: 'POST /auth/forgot-password and /auth/worker-forgot-pin had no caller in the app: no sign-in page had a "Forgot password / PIN" link, and the reset pages, opened without a link, said "request a new reset from the sign-in page", which could not be done. The super-admin sign-in page\'s "Run one-time setup" linked to /superadmin-setup, which does not exist. Found by the 2026-10 product and architecture review (PAR-10/26).',
  module: 'ele',
  category: 'account-recovery',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/26)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The request side of the reset flow was built as API only; the setup hint pointed at a page that was never written.',
  expectedBehavior: 'Each sign-in page links to a request form (the reset page without a token); the super-admin hint runs POST /auth/bootstrap with the key entered.',
  brokenBehavior: 'No way to request a reset from the app; the setup link opened a page that does not exist.',
  reproductionSteps: [
    'Open /<org>/ele/admin-login (or the supervisor or electrician sign-in page).',
    'Broken: no "Forgot password?" link; /reset-password without a token is a dead end. Fixed: link → email → "If an account exists…".',
    'Browser test: e2e/tests/forms.spec.js (BUG-0051).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    const org = await createTestOrg();
    return { org };
  },

  async validate(ctx) {
    for (const [page, target] of LINKS) {
      const src = read(page);
      if (!src.includes(`id="forgotLink" href="${target}"`)) return { ok: false, detail: `${page} has no "Forgot …?" link to ${target}` };
      if (!src.includes(`.href = '${target}?org=' + encodeURIComponent(orgSlug)`)) return { ok: false, detail: `${page}'s link does not carry the organization` };
    }
    for (const [script, call] of REQUESTS) {
      if (!read(script).includes(call)) return { ok: false, detail: `${script} does not request a reset link (${call})` };
    }
    const sa = read('superadmin-login.html');
    if (sa.includes('href="/superadmin-setup"')) return { ok: false, detail: 'superadmin-login.html still links to /superadmin-setup' };
    if (!sa.includes("fetch('/api/auth/bootstrap'")) return { ok: false, detail: 'the setup hint does not run the bootstrap' };

    // The endpoints the forms call answer the generic message, for an unknown account too.
    const { org } = ctx['BUG-0051'];
    const staff = await ctx.app.inject({ method: 'POST', url: '/api/auth/forgot-password', headers: { 'x-forwarded-for': '10.88.51.1' }, payload: { email: 'nobody-0051@example.test', orgSlug: org.slug } });
    if (staff.statusCode !== 200) return { ok: false, detail: `forgot-password answered ${staff.statusCode}` };
    const worker = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-forgot-pin', headers: { 'x-forwarded-for': '10.88.51.2' }, payload: { orgSlug: org.slug, employeeId: 'NOBODY-0051' } });
    if (worker.statusCode !== 200) return { ok: false, detail: `worker-forgot-pin answered ${worker.statusCode}` };
    return { ok: true, detail: 'every sign-in page links to a reset request; the setup hint runs the bootstrap' };
  }
};
