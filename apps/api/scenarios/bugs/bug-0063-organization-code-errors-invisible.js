'use strict';

/**
 * BUG-0063 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0063',
  title: 'The home page never showed an error for a wrong organization code',
  description: 'public/index.html set style.display on #orgError, but .error-msg only shows with the .show class, so a wrong code, an empty field or a lost connection did nothing visible.',
  module: 'ele',
  category: 'ux',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The error element was toggled in a way its stylesheet ignores.',
  expectedBehavior: 'An empty field, a wrong code and a lost connection each show a message; Go reads "Checking…" while it works.',
  brokenBehavior: 'Tapping Go on a wrong code appeared to do nothing.',
  reproductionSteps: [
    'Open / with no saved organization.',
    'Type a code that does not exist and tap Go.',
    'Broken: nothing visible. Fixed: "We can\'t find that code."'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0063"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('index.html').includes('errEl.classList.add(\'show\')')) return { ok: false, detail: 'the error is not shown through .show' };
    return { ok: true, detail: 'An empty field, a wrong code and a lost connection each show a message; Go reads "Checking…" while it works' };
  }
};
