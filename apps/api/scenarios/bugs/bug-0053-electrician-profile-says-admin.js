'use strict';

/**
 * BUG-0053 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');

module.exports = {
  id: 'BUG-0053',
  title: 'The profile of an electrician said "Admin"',
  description: 'public/js/app.js _renderProfileModal mapped SUPER_ADMIN and SUPERVISOR to their labels and everything else to "Admin", so an electrician\'s profile (role ELECTRICIAN) showed an Admin badge. Found while fixing BUG-0052.',
  module: 'ele',
  category: 'ui',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Found while fixing BUG-0052 (2026-10-25)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'A two-way ternary with "Admin" as the default.',
  expectedBehavior: 'The badge reads Electrician for an electrician.',
  brokenBehavior: 'The badge read Admin.',
  reproductionSteps: [
    'Sign in as an electrician; user menu → Profile.',
    'Broken: "Admin". Fixed: "Electrician". Browser test: e2e/tests/forms.spec.js (BUG-0053).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    if (!src.includes("ELECTRICIAN: 'Electrician'")) return { ok: false, detail: 'the profile badge has no Electrician label' };
    return { ok: true, detail: 'the profile badge names the electrician role' };
  }
};
