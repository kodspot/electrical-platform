'use strict';

/**
 * BUG-0068 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0068',
  title: 'Print All could be pressed while the QR stickers were still loading',
  description: 'admin-qr-print.html fetches QR images in batches and left Print All enabled, so a large hostel could print a partial set; a failed image printed as a grey box with no warning.',
  module: 'ele',
  category: 'workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The button was not tied to the loading state.',
  expectedBehavior: 'Print All stays disabled until every sticker is on the page; failures are counted, can be retried, and need a confirmation to print without.',
  brokenBehavior: 'A partial or gapped print with nothing to say so.',
  reproductionSteps: [
    'Open admin-qr-print on a slow connection and press Print All.',
    'Broken: a partial set. Fixed: the button stays disabled until "Ready: N stickers".'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0068"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-qr-print.html').includes('id="printBtn" onclick="printAll()" disabled')) return { ok: false, detail: 'Print All is enabled during the load' };
    return { ok: true, detail: 'Print All stays disabled until every sticker is on the page; failures are counted, can be retried, and need a confirmation to print without' };
  }
};
