'use strict';

/**
 * BUG-0081 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0081',
  title: 'A resident erasure request could not be met before the 180-day cleanup',
  description: 'The privacy notice offers erasure, but no tool cleared one person, so a request waited for the scheduled job. AUD-11/06.',
  module: 'ele',
  category: 'privacy',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'Only the scheduled job could clear guest details.',
  expectedBehavior: 'An admin erases the reporter of one complaint; the ticket stays and the erasure is audited without the name.',
  brokenBehavior: 'The details stayed until day 180.',
  reproductionSteps: [
    'Open a resident complaint as an admin.',
    'Press Erase this person’s details.',
    'Fixed: name, phone, address hash and browser string are gone, on the ticket and in its audit row.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/test/integration/erase-reporter.test.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('src/routes/tickets.js').includes(`'/tickets/:id/erase-reporter'`)) return { ok: false, detail: 'the route is missing' };
    if (!read('public/admin-tickets.html').includes('function eraseReporter(id)')) return { ok: false, detail: 'the button is missing' };
    return { ok: true, detail: 'one reporter can be erased' };
  }
};
