'use strict';

/**
 * BUG-0069 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0069',
  title: 'Tapping a ticket count tile showed every ticket instead of that group',
  description: 'admin-tickets.html set the status select to a comma list (OPEN,ACKNOWLEDGED,ASSIGNED). No option has that value, so the select fell back to empty and the list showed everything.',
  module: 'ele',
  category: 'data-accuracy',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'A multi-status filter stored in a single-value select.',
  expectedBehavior: 'A tile filters to its group, shows as pressed, and a second tap or Clear filters removes it.',
  brokenBehavior: 'The Open tile showed all tickets.',
  reproductionSteps: [
    'Open admin-tickets with tickets in several states.',
    'Tap Open.',
    'Broken: all tickets. Fixed: only the open group.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0069"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-tickets.html').includes('var status = statusGroup || $(\'filterStatus\').value;')) return { ok: false, detail: 'the tile group is not used by the query' };
    return { ok: true, detail: 'A tile filters to its group, shows as pressed, and a second tap or Clear filters removes it' };
  }
};
