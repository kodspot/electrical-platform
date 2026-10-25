'use strict';

/**
 * BUG-0056 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');

module.exports = {
  id: 'BUG-0056',
  title: 'Analytics charts counted inspections between midnight and 05:30 under the day before',
  description: 'The analytics trends, report, room heatmap and location history, and the super-admin activity and AI-usage charts, grouped by UTC day: SQL DATE("inspectedAt") on a column holding UTC, and toISOString() date keys. In India an inspection between 00:00 and 05:30 counted on the previous day, and the report\'s day labels were shifted by one (its first label before the range, its last day missing). Found by the 2026-10 product and architecture review (PAR-10/07).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/07)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-26',
  rootCause: 'Day keys taken in UTC while the server and its users are in IST.',
  expectedBehavior: 'Every chart groups by the local day: localDateKey() in JS, DATE(col AT TIME ZONE \'UTC\' AT TIME ZONE <server zone>) in SQL.',
  brokenBehavior: 'An inspection at 01:00 counted on the day before; the report period started a day early.',
  reproductionSteps: [
    'With TZ=Asia/Kolkata, record inspections at 01:00 and 23:30 on one day.',
    'GET /api/analytics/report?from=<day>&to=<day>. Broken: trend keyed by the day before. Fixed: [{ date: <day>, count: 2 }].',
    'Regression: test/integration/analytics-local-days.test.js (runs in Asia/Kolkata).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/analytics-local-days.test.js',

  async apply() {
    return {};
  },

  async validate() {
    for (const file of ['analytics.js', 'superadmin.js']) {
      const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
      if (/DATE\("\w+"\)/.test(src)) return { ok: false, detail: `${file} groups by the UTC day in SQL` };
    }
    const analytics = fs.readFileSync(path.join(ROUTES, 'analytics.js'), 'utf8');
    if (/\.toISOString\(\)\.split\('T'\)\[0\]/.test(analytics.replace(/new Date\(d\.date\)\.toISOString\(\)\.split\('T'\)\[0\]/g, ''))) return { ok: false, detail: 'analytics.js keys a day by its UTC date' };
    return { ok: true, detail: 'analytics group by the local day' };
  }
};
