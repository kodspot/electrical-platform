'use strict';

/**
 * BUG-0061 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0061',
  title: 'A lost connection left the page stuck on its loading state',
  description: 'public/js/app.js _doFetch rethrew a network failure, and most pages only checked for a null response, so an uncaught rejection left the button disabled or the skeleton on screen.',
  module: 'ele',
  category: 'resilience',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The fetch wrapper had two failure shapes (null and a throw) and the pages handled one.',
  expectedBehavior: 'A lost connection shows "No connection. Check your signal and try again." and answers null, unless the caller passes throwOnNetwork (the inspection page, which queues offline).',
  brokenBehavior: 'An unhandled rejection; the page sat on "Saving…" or a skeleton.',
  reproductionSteps: [
    'Load app.js with a fetch that rejects.',
    'App.apiFetch("/x").',
    'Broken: the call rejects. Fixed: it answers null, and a toast says why.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/public-escaping.test.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('js/app.js').includes('throwOnNetwork')) return { ok: false, detail: 'the wrapper has no throwOnNetwork path' };
    if (!read('js/app.js').includes('No connection. Check your signal and try again.')) return { ok: false, detail: 'no message for a lost connection' };
    if (!read('supervisor-electrical.html').includes('throwOnNetwork: true')) return { ok: false, detail: 'the inspection page no longer catches the failure it queues offline' };
    return { ok: true, detail: 'A lost connection shows "No connection' };
  }
};
