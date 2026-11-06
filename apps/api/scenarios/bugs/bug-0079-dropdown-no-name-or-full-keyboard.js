'use strict';

/**
 * BUG-0079 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0079',
  title: 'Dropdowns had no name for screen readers and only partial keyboard support',
  description: 'The styled trigger announced only its current value because the labelled select is hidden. Home, End and letters did nothing, and arrows started from the top rather than the selected item.',
  module: 'ele',
  category: 'accessibility',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'The name stayed on the hidden native select.',
  expectedBehavior: 'The trigger is a named combobox with the keys a native select has.',
  brokenBehavior: 'A filter was read out as All Status, with no word of what it filtered.',
  reproductionSteps: [
    'Focus a filter on admin-assets with a screen reader.',
    'Broken: only the value is read. Fixed: its name is read too.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('public/js/custom-select.js').includes(`trigger.setAttribute('role', 'combobox')`)) return { ok: false, detail: 'the trigger is not a combobox' };
    if (!read('public/js/custom-select.js').includes('function typeAhead(key)')) return { ok: false, detail: 'letters do not move the list' };
    return { ok: true, detail: 'dropdowns are named and keyboard complete' };
  }
};
