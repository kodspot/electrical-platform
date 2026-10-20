'use strict';

/**
 * BUG-0024 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', '..', 'public', 'supervisor-assets.html');

module.exports = {
  id: 'BUG-0024',
  title: 'After logging an asset event or reporting a failure, the supervisor saw a blank page',
  description: 'supervisor-assets.html hid the main view and showed the confirmation with `successView.style.display = \'\'`. The page\'s stylesheet has `.success-screen { display: none }`, so clearing the inline style left the confirmation hidden: below the nav bar the page was empty, with no "Back to Asset" button. The event or failure itself was saved.',
  module: 'asset',
  category: 'ui',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (every button and form)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'showSuccess() set display to the empty string on an element whose CSS default is display:none.',
  expectedBehavior: 'The confirmation ("Event Logged!" / "Failure Reported!") is shown, with "Back to Asset".',
  brokenBehavior: 'A blank page under the nav bar.',
  reproductionSteps: [
    'As a supervisor, open Assets, pick an asset, Log Inspection with a summary, submit.',
    'Broken: blank page. Fixed: the confirmation. Browser test: e2e/tests/forms.spec.js (BUG-0024).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    const src = fs.readFileSync(PAGE, 'utf8');
    const hiddenByCss = /\.success-screen\{[^}]*display:none/.test(src);
    const fn = src.slice(src.indexOf('function showSuccess('), src.indexOf('function backToAsset('));
    const shown = /\$\('successView'\)\.style\.display\s*=\s*'(block|flex)'/.test(fn);
    if (hiddenByCss && !shown) return { ok: false, detail: 'showSuccess() leaves the CSS display:none in force' };
    return { ok: true, detail: 'the confirmation is displayed explicitly' };
  }
};
