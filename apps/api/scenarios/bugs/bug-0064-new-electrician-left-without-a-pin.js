'use strict';

/**
 * BUG-0064 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0064',
  title: 'Adding an electrician left them unable to sign in, with nothing to say so',
  description: 'admin-workers.html closed the form after a create with no PIN set and no mention of one. The electrician could not sign in until the admin found the PIN button on the row.',
  module: 'ele',
  category: 'workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The PIN was treated as a separate action, not as part of adding the person.',
  expectedBehavior: 'A successful add goes straight to "Last step: set a PIN"; after the PIN, the location assignment opens.',
  brokenBehavior: 'The form closed with "Electrician created"; the electrician\'s first sign-in failed.',
  reproductionSteps: [
    'Add an electrician as an admin.',
    'Broken: back on the list. Fixed: the PIN screen opens for them.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/journeys.spec.js › J3',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-workers.html').includes('openSetPin(worker.id, worker.name, true)')) return { ok: false, detail: 'adding an electrician does not lead to the PIN' };
    return { ok: true, detail: 'A successful add goes straight to "Last step: set a PIN"; after the PIN, the location assignment opens' };
  }
};
