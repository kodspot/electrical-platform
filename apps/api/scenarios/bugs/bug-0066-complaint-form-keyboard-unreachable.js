'use strict';

/**
 * BUG-0066 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0066',
  title: 'The resident complaint form could not be used without a touch screen or mouse',
  description: 'public/scan.html built the service and issue choices from clickable divs: no keyboard focus, no role, nothing for a screen reader. The issue choice is required, so the form could not be sent.',
  module: 'ele',
  category: 'accessibility',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'Clickable divs in place of buttons and radio inputs.',
  expectedBehavior: 'Service choices are buttons; issue choices are a radio group in a fieldset, operable by keyboard.',
  brokenBehavior: 'A keyboard or screen-reader user could not choose a problem, so could not report it.',
  reproductionSteps: [
    'Open a QR link with the keyboard only.',
    'Broken: Tab never reaches the choices. Fixed: arrows choose, and Send report is enabled.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0066"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('scan.html').includes('<input class="sr-only" type="radio" name="issue"')) return { ok: false, detail: 'the issue choices are not radio inputs' };
    if (!read('scan.html').includes('<button type="button" class="role-card"')) return { ok: false, detail: 'the service choices are not buttons' };
    return { ok: true, detail: 'Service choices are buttons; issue choices are a radio group in a fieldset, operable by keyboard' };
  }
};
