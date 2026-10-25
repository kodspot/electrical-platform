'use strict';

/**
 * BUG-0055 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { dayRange } = require('../../src/lib/dates');

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');
const PUBLIC = path.join(__dirname, '..', '..', 'public');
// Each list or report that takes a from/to date.
const FILTERS = ['tickets.js', 'audit-logs.js', 'alerts.js', 'asset-events.js', 'asset-failures.js', 'electrical.js', 'analytics.js'];

module.exports = {
  id: 'BUG-0055',
  title: 'Date filters started each day at 05:30 in India (UTC midnight), and pages took "today" from UTC',
  description: 'The ticket, audit-log, alert, asset-event, asset-failure, inspection and analytics filters parsed a date-only `from` as UTC midnight — 05:30 IST — so the first 5.5 hours of a range were left out; the ticket and audit-log filters ended `to` at 05:29 the next morning, and three analytics endpoints at 05:30 on the last day. Admin pages built "today" and their preset ranges with toISOString(), the UTC date, which is yesterday between 00:00 and 05:30 IST. Found by the 2026-10 product and architecture review (PAR-10/07).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/07)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'new Date("YYYY-MM-DD") is UTC midnight; the server and its users are in IST. Each route parsed its own way.',
  expectedBehavior: 'One rule (lib/dates.js dayRange): a date-only value is the local day, 00:00 to 23:59:59.999 in the server\'s TZ. Pages use App.localDate().',
  brokenBehavior: 'A ticket raised at 01:00 IST was missing from that day\'s list, and showed in the previous day\'s.',
  reproductionSteps: [
    'With TZ=Asia/Kolkata, raise a ticket at 01:00 IST.',
    'GET /api/tickets?from=<that day>&to=<that day>. Broken: missing (and listed under the day before). Fixed: listed.',
    'Regression: test/integration/date-filters-local-day.test.js (runs in Asia/Kolkata).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/date-filters-local-day.test.js',

  async apply() {
    return {};
  },

  async validate() {
    // The rule itself, independent of the zone the test runs in: the local day's bounds.
    const r = dayRange('2026-03-10', '2026-03-10');
    const start = new Date(2026, 2, 10, 0, 0, 0, 0);
    const end = new Date(2026, 2, 10, 23, 59, 59, 999);
    if (r.gte.getTime() !== start.getTime() || r.lte.getTime() !== end.getTime()) return { ok: false, detail: `dayRange is not the local day: ${r.gte.toISOString()} – ${r.lte.toISOString()}` };
    for (const file of FILTERS) {
      const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
      if (!src.includes('dayRange(from, to)')) return { ok: false, detail: `${file} does not use dayRange` };
      if (/new Date\(from(\s*\+\s*'T00:00:00Z')?\)/.test(src)) return { ok: false, detail: `${file} still parses from by itself` };
    }
    for (const page of ['admin-analytics.html', 'admin-audit-logs.html', 'admin-dashboard.html']) {
      if (/toISOString\(\)\.(split\('T'\)\[0\]|slice\(0, *10\))/.test(fs.readFileSync(path.join(PUBLIC, page), 'utf8'))) return { ok: false, detail: `${page} takes a date from UTC` };
    }
    return { ok: true, detail: 'one local-day rule for every date filter' };
  }
};
