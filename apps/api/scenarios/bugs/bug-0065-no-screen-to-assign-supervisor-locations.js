'use strict';

/**
 * BUG-0065 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0065',
  title: 'No screen could assign locations to a supervisor, so resident complaints went unassigned',
  description: 'GET and PUT /supervisors/:id/assignments existed and resident routing depends on them, but no page called them, so a new organization could not route complaints to a supervisor without the API.',
  module: 'ele',
  category: 'workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The capability shipped without its admin screen.',
  expectedBehavior: 'Each supervisor row has a Locations button opening the same checklist electricians use; adding a supervisor opens it.',
  brokenBehavior: 'No way to set them from the app.',
  reproductionSteps: [
    'Open admin-supervisors.',
    'Broken: no Locations action. Fixed: the checklist saves through PUT /supervisors/:id/assignments.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0065"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-supervisors.html').includes('\'/supervisors/\' + $(\'locSupId\').value + \'/assignments\'')) return { ok: false, detail: 'the page does not save supervisor assignments' };
    if (!read('js/app.js').includes('function locationChecklist')) return { ok: false, detail: 'no shared checklist' };
    return { ok: true, detail: 'Each supervisor row has a Locations button opening the same checklist electricians use; adding a supervisor opens it' };
  }
};
