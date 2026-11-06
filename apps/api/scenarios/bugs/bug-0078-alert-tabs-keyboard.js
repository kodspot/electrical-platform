'use strict';

/**
 * BUG-0078 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0078',
  title: 'The tabs on the alerts page could not be used by keyboard',
  description: 'The tabs were div elements with onclick, so they took no focus and were announced as plain text. Every tab row now shares App.initTabs.',
  module: 'ele',
  category: 'accessibility',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'Each page built its own tabs.',
  expectedBehavior: 'Tabs are buttons with tab roles and arrow keys.',
  brokenBehavior: 'Keyboard users could not leave the Rules tab.',
  reproductionSteps: [
    'Open admin-alerts.',
    'Press Tab.',
    'Broken: focus skips the tabs. Fixed: arrow keys move between them.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('public/admin-alerts.html').includes('<button class="tab active"')) return { ok: false, detail: 'the tabs are not buttons' };
    if (!read('public/js/app.js').includes('function initTabs(list)')) return { ok: false, detail: 'the shared tabs are missing' };
    return { ok: true, detail: 'tabs are buttons with shared keyboard handling' };
  }
};
