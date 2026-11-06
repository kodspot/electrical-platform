'use strict';

/**
 * BUG-0080 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0080',
  title: 'Save did nothing when a required field was on another tab',
  description: 'In the electrician form, pressing Save from Personal or Notes with an empty name was refused by the browser, which cannot show a message on a hidden field, so nothing appeared to happen.',
  module: 'ele',
  category: 'ux',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'Native validation cannot reach a hidden control.',
  expectedBehavior: 'The tab with the empty field opens and the field takes focus.',
  brokenBehavior: 'The button appeared dead.',
  reproductionSteps: [
    'Add an electrician.',
    'Open Notes and press Save.',
    'Broken: nothing happens. Fixed: Basic Info opens at Name.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('public/js/app.js').includes('function _showInvalidField(e)')) return { ok: false, detail: 'hidden invalid fields are not shown' };
    if (!read('public/admin-workers.html').includes('data-tab-panel="basic"')) return { ok: false, detail: 'the form does not name its tab panel' };
    return { ok: true, detail: 'the tab with the field opens' };
  }
};
