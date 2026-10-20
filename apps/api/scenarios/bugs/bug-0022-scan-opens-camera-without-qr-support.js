'use strict';

/**
 * BUG-0022 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PAGES = ['electrician-scan.html', 'supervisor-scan.html'];

module.exports = {
  id: 'BUG-0022',
  title: 'On a phone that cannot scan QR codes (iPhone Safari), "Open Camera" switched the camera on with nothing reading it',
  description: 'The electrician and supervisor scan pages opened the camera first and only then checked for BarcodeDetector. On iPhone Safari (no BarcodeDetector) the live camera stayed on — privacy indicator lit, battery used — under a "not supported, enter the code manually" message, until the user found Stop. Manual code entry itself worked.',
  module: 'ele',
  category: 'ui',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (QR scan without BarcodeDetector)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'startCamera() called getUserMedia before testing `\'BarcodeDetector\' in window`, and never stopped the stream in the unsupported branch.',
  expectedBehavior: 'Without QR support (no BarcodeDetector, or one without qr_code) the camera is never opened; the page says so and focuses the code field.',
  brokenBehavior: 'getUserMedia ran and the video stayed live with nothing scanning.',
  reproductionSteps: [
    'Open the electrician (or supervisor) Scan page in a browser without BarcodeDetector.',
    'Tap "Open Camera".',
    'Broken: the camera turns on. Fixed: it stays off and the manual code field is focused. Browser test: e2e/tests/forms.spec.js (BUG-0022).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    for (const page of PAGES) {
      const src = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
      const start = src.indexOf('async function startCamera()');
      if (start === -1) return { ok: false, detail: `${page}: no startCamera()` };
      const body = src.slice(start, src.indexOf('\n}\n', start));
      const check = body.indexOf('qrScanSupported()');
      const camera = body.indexOf('getUserMedia(');
      if (check === -1 || camera === -1 || check > camera) return { ok: false, detail: `${page}: the camera opens before QR support is checked` };
    }
    return { ok: true, detail: 'both scan pages check QR support before opening the camera' };
  }
};
