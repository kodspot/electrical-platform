'use strict';

/**
 * BUG-0073 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0073',
  title: 'A failed load read as "no tickets", so staff could think there was no work',
  description: 'admin-tickets.html and supervisor-tickets.html returned quietly on a failed request and showed an empty list or a stuck skeleton; other pages said "No workers" for a refused request.',
  module: 'ele',
  category: 'resilience',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'No distinction between "the request failed" and "nothing matched".',
  expectedBehavior: 'App.loadFailed says it could not load and offers Try again; "no tickets" appears only for a real empty answer.',
  brokenBehavior: 'On a weak signal a supervisor saw an empty queue.',
  reproductionSteps: [
    'Open admin-tickets with the request failing.',
    'Broken: empty. Fixed: "Could not load the tickets." with Try again.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0073"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-tickets.html').includes('App.loadFailed($(\'ticketEmpty\')')) return { ok: false, detail: 'admin-tickets reads a failure as empty' };
    if (!read('supervisor-tickets.html').includes('App.loadFailed($(\'ticketList\')')) return { ok: false, detail: 'supervisor-tickets reads a failure as empty' };
    if (!read('electrician-tickets.html').includes('App.loadFailed(list')) return { ok: false, detail: 'electrician-tickets reads a failure as empty' };
    return { ok: true, detail: 'App' };
  }
};
