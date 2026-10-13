'use strict';

/**
 * Bug scenario registry. [platform-M4, DPS §6]
 *
 * The permanent library: every fixed defect encoded as a reproducible scenario with
 * metadata and a regression mapping. Adding a bug is one line here plus one module in
 * this directory — nothing else changes.
 */

const BUGS_LIST = [
  require('./bug-0001-ticket-pending-verify-direct-set'),
  require('./bug-0002-worker-permanent-delete-loses-history'),
  require('./bug-0003-public-complaint-spam-not-enforced'),
  require('./bug-0004-assigned-supervisor-double-notified'),
  require('./bug-0005-worker-created-without-employee-id')
];

const BUGS = Object.fromEntries(BUGS_LIST.map((b) => [b.id, b]));

function all() { return BUGS_LIST; }
function get(id) { return BUGS[id]; }
function has(id) { return Object.prototype.hasOwnProperty.call(BUGS, id); }
function list() {
  return BUGS_LIST.map((b) => ({
    id: b.id, title: b.title, severity: b.severity, status: b.status,
    module: b.module, category: b.category, regressionTest: b.regressionTest
  }));
}

module.exports = { BUGS, all, get, has, list };
