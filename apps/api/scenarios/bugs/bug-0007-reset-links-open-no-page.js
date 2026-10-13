'use strict';

/**
 * BUG-0007 — a fixed defect, encoded as a reproducible scenario + regression. [F12]
 */

module.exports = {
  id: 'BUG-0007',
  title: 'Password and PIN reset links from email opened no page ("Organization not found")',
  description: 'The reset emails link to /reset-password?token=… and /worker-reset-pin?token=…, but no such pages existed; both URLs fell through to the /:orgSlug page route, which answered "Organization not found". Users could not reset from the email.',
  module: 'ele',
  category: 'account-recovery',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Batch 1 characterisation (finding F12), fixed in C10',
  dateIntroduced: '2026-07-21',
  dateFixed: '2026-10-13',
  rootCause: 'WP14 added the reset APIs and the emailed links (auth.js, worker-auth.js) but no pages for the links to open; pages.js had no route for either path, so /:orgSlug matched them.',
  expectedBehavior: 'GET /reset-password?token=… and GET /worker-reset-pin?token=… serve the reset pages (200, HTML).',
  brokenBehavior: '404 {"error":"Organization not found"} (via the /:orgSlug route).',
  reproductionSteps: [
    'Request a password or PIN reset; open the emailed link.',
    'Broken: "Organization not found". Fixed: the reset page with a new-password / new-PIN form.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    return {};
  },

  async validate(ctx) {
    for (const page of ['/reset-password', '/worker-reset-pin']) {
      const res = await ctx.app.inject({ method: 'GET', url: `${page}?token=bug0007-placeholder` });
      if (res.statusCode !== 200 || !/text\/html/.test(res.headers['content-type'] || '')) {
        return { ok: false, detail: `${page} expected 200 HTML, got ${res.statusCode} ${res.body.slice(0, 60)}` };
      }
    }
    return { ok: true, detail: 'both reset links open their reset pages (200 HTML)' };
  }
};
