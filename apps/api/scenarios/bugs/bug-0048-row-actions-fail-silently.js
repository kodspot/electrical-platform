'use strict';

/**
 * BUG-0048 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// [page, the request a row action sends] — each must report a refusal with App.toastFailure.
const ACTIONS = [
  ['admin-alerts.html', "apiFetch('/alert-rules/'+id,{method:'DELETE'})"],
  ['admin-alerts.html', "apiFetch('/alerts/'+id+'/acknowledge',{method:'PATCH'})"],
  ['admin-alerts.html', "apiFetch('/alerts/acknowledge-all',{method:'PATCH'})"],
  ['admin-assets.html', "App.apiFetch('/assets/'+id, {method:'DELETE'})"],
  ['admin-electrical.html', "App.apiFetch('/electrical-inspections/' + id + '/flag'"]
];

module.exports = {
  id: 'BUG-0048',
  title: 'Row actions the server refused (delete a rule, acknowledge an alert, flag an inspection) said nothing',
  description: 'Several admin row actions only acted when the request succeeded: on a 4xx/5xx — for example a rule or alert another admin had just removed — the page showed no message and the row stayed as if nothing happened. App.apiFetch returns such responses to the caller without a message. Found by the 2026-10 product and architecture review (PAR-10/53).',
  module: 'ele',
  category: 'ui',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/53)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The handlers had no else branch for a refused request.',
  expectedBehavior: 'A refused row action shows the server\'s error message (App.toastFailure).',
  brokenBehavior: 'Nothing visible happened.',
  reproductionSteps: [
    'Open admin-alerts; in another session delete one of the listed rules.',
    'Press Delete on that rule.',
    'Broken: nothing. Fixed: "Rule not found". Browser test: e2e/tests/forms.spec.js (BUG-0048).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8').includes('toastFailure: toastFailure')) return { ok: false, detail: 'App.toastFailure is missing' };
    for (const [page, call] of ACTIONS) {
      const src = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
      const at = src.indexOf(call);
      if (at === -1) return { ok: false, detail: `${page}: the action ${call} is gone (update this scenario)` };
      const handler = src.slice(at, src.indexOf('\n}', at));
      if (!handler.includes('App.toastFailure(res')) return { ok: false, detail: `${page}: ${call} does not report a refusal` };
    }
    return { ok: true, detail: 'every row action reports a refusal' };
  }
};
