'use strict';

/**
 * BUG-0014 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

module.exports = {
  id: 'BUG-0014',
  title: 'The admin Alerts page was always dark, unlike every other admin page',
  description: 'admin-alerts.html hard-coded <html data-theme="dark">, so the page switched to the dark token set while the rest of the admin app is light. Its own styles already used the design tokens. Found by the QA-2 visual baselines.',
  module: 'ele',
  category: 'ui',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'QA-2 visual baselines (2026-10-17); fixed 2026-10-18',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-18',
  rootCause: 'A data-theme="dark" attribute left on the page\'s <html> element.',
  expectedBehavior: 'No admin page forces a theme on <html>; they all use the admin design tokens.',
  brokenBehavior: 'admin-alerts rendered in the dark theme.',
  reproductionSteps: ['Sign in as an admin and open /{org}/ele/admin-alerts.', 'Broken: a dark page. Fixed: the light admin theme.'],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js; e2e visual baseline admin-alerts',

  async apply() {
    return {};
  },

  async validate() {
    const forced = fs.readdirSync(PUBLIC_DIR).filter((f) => /^admin-.+\.html$/.test(f))
      .filter((f) => /<html[^>]*\sdata-theme=/.test(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')));
    if (forced.length) return { ok: false, detail: `admin pages force a theme on <html>: ${forced.join(', ')}` };
    return { ok: true, detail: 'no admin page forces a theme on <html>' };
  }
};
