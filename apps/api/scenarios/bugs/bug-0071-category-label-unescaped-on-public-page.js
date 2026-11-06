'use strict';

/**
 * BUG-0071 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0071',
  title: 'Complaint category labels went unescaped into the public complaint form',
  description: 'public/scan.html wrote each category key and label into innerHTML without escaping. Labels come from an admin, and the page is open to every resident who scans a sticker, so markup in a label ran there. esc() also left double quotes alone, which matters in attributes.',
  module: 'ele',
  category: 'security',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'Only some interpolations were escaped, and the escape helper did not cover attributes.',
  expectedBehavior: 'Labels and keys are escaped, quotes included.',
  brokenBehavior: 'A category label containing markup rendered as markup for residents.',
  reproductionSteps: [
    'Create a category labelled with an img tag and an onerror handler.',
    'Open a QR link.',
    'Broken: it runs. Fixed: it shows as text.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0071-category-label-unescaped-on-public-page.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('scan.html').includes('\'</span>\' + esc(i.label) + \'</span>\'')) return { ok: false, detail: 'the label is written unescaped' };
    if (!read('scan.html').includes('.replace(/"/g, \'&quot;\')')) return { ok: false, detail: 'esc() leaves quotes alone' };
    return { ok: true, detail: 'Labels and keys are escaped, quotes included' };
  }
};
