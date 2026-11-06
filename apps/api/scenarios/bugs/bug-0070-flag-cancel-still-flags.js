'use strict';

/**
 * BUG-0070 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0070',
  title: 'Cancelling the flag reason still flagged the inspection',
  description: 'admin-electrical.html read prompt() || \'\', so Cancel and an empty answer looked the same and the inspection was flagged either way.',
  module: 'ele',
  category: 'data-integrity',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'A cancelled prompt was treated as an empty reason.',
  expectedBehavior: 'Cancel leaves the inspection unchanged.',
  brokenBehavior: 'Cancel flagged it, with no reason.',
  reproductionSteps: [
    'Open an inspection and tap Flag.',
    'Cancel.',
    'Broken: it is flagged. Fixed: unchanged.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "the submission can be flagged"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-electrical.html').includes('if (reason === null) return;')) return { ok: false, detail: 'Cancel is not honoured' };
    return { ok: true, detail: 'Cancel leaves the inspection unchanged' };
  }
};
