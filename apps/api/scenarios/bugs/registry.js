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
  require('./bug-0005-worker-created-without-employee-id'),
  require('./bug-0006-empty-json-body-rejected'),
  require('./bug-0007-reset-links-open-no-page'),
  require('./bug-0008-worker-photos-open-db-breaker'),
  require('./bug-0009-supervisor-delete-fk-error'),
  require('./bug-0010-role-nav-double-prefix'),
  require('./bug-0011-hidden-nav-link-double-prefix'),
  require('./bug-0012-analytics-undefined-fields'),
  require('./bug-0013-admin-pages-without-admin-shell'),
  require('./bug-0014-admin-alerts-forced-dark-theme'),
  require('./bug-0015-electrician-unverifies-ticket'),
  require('./bug-0016-reopened-ticket-closed-by-old-review'),
  require('./bug-0017-no-second-guest-review'),
  require('./bug-0018-electrician-not-told-outcome'),
  require('./bug-0019-escalation-reaches-no-one-at-location'),
  require('./bug-0020-complaint-in-disabled-module'),
  require('./bug-0021-edit-forms-ignore-cleared-fields'),
  require('./bug-0022-scan-opens-camera-without-qr-support'),
  require('./bug-0023-org-create-needs-email'),
  require('./bug-0024-supervisor-asset-blank-after-save'),
  require('./bug-0025-roster-suggests-no-covering-electrician'),
  require('./bug-0026-rejected-ticket-stuck-for-electrician'),
  require('./bug-0027-electrician-sees-guest-review-token'),
  require('./bug-0028-attribute-xss-via-names'),
  require('./bug-0029-test-run-green-when-suite-throws'),
  require('./bug-0030-supervisor-aadhaar-plaintext'),
  require('./bug-0031-worker-responses-carry-credentials'),
  require('./bug-0032-admin-runs-every-tenants-checks'),
  require('./bug-0033-late-proof-photo-deleted'),
  require('./bug-0034-reset-tokens-stored-raw'),
  require('./bug-0035-worker-delete-history-guard'),
  require('./bug-0036-test-run-green-when-after-hook-throws'),
  require('./bug-0037-deactivated-supervisor-keeps-tickets'),
  require('./bug-0038-concurrent-transitions-both-win'),
  require('./bug-0039-analytics-perf-and-dashboard-log-fields'),
  require('./bug-0040-admin-detail-photos-broken'),
  require('./bug-0041-guest-cannot-see-proof-photo'),
  require('./bug-0042-rejected-ticket-keeps-resolution-times'),
  require('./bug-0043-alert-form-drops-location-actions'),
  require('./bug-0044-alert-tickets-unassigned-unaudited'),
  require('./bug-0045-missed-inspection-alert-timing-and-dedup'),
  require('./bug-0046-jwt-any-hmac-algorithm-accepted'),
  require('./bug-0047-client-repeats-lost-submissions'),
  require('./bug-0048-row-actions-fail-silently'),
  require('./bug-0049-zero-purchase-cost-lost'),
  require('./bug-0050-rung-for-ticket-under-inactive-location'),
  require('./bug-0051-no-way-to-request-a-reset')
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
