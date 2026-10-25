'use strict';

/**
 * BUG-0039 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { createTestOrg, createTestUser, createTestLocation, createTestWorker, createTestElectricalInspection } = require('../factories');
const { localDateKey } = require('../../src/lib/dates');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** The `<v>.<field>` names a function's body reads, e.g. fieldsRead(src, 'renderWorkers', 'w'). */
function fieldsRead(src, fn, v) {
  const start = src.indexOf(`function ${fn}(`);
  if (start === -1) return null;
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...new Set([...body.matchAll(new RegExp(`\\b${v}\\.([a-zA-Z_]+)`, 'g'))].map((m) => m[1]))];
}

module.exports = {
  id: 'BUG-0039',
  title: 'Analytics labelled every electrician and supervisor bar "undefined"; the dashboard\'s inspection log was always empty',
  description: 'admin-analytics.html read topWorkers[].records and topSupervisors[].records; GET /api/analytics/report sends `inspections`, so each performance bar showed "undefined" with a NaN width. admin-dashboard.html read `inspections` from GET /api/electrical-inspections, which sends `records`, so "Today\'s Inspection Log" always said "No inspections logged today" (PAR-10/27). Both show only when inspections exist, which is why the explorer flagged the first only in full runs. Found by the 2026-10 product and architecture review and the full local e2e run.',
  module: 'ele',
  category: 'ui',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/27) and the full e2e run (explorer rawValue on admin-analytics)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The pages kept field names the APIs do not send (the BUG-0012 class).',
  expectedBehavior: 'Every field the performance bars and the inspection log read exists in the API responses.',
  brokenBehavior: 'Bars labelled "undefined"; the log always empty.',
  reproductionSteps: [
    'Sign in as an admin of an org with an inspection today that names an electrician.',
    'Open admin-analytics, then admin-dashboard.',
    'Broken: the bars read "undefined"; the log says "No inspections logged today". Browser test: e2e/tests/ui-fixes.spec.js (BUG-0039).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/ui-fixes.spec.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id);
    await createTestElectricalInspection(org.id, location.id, supervisor.id, { inspectedAt: new Date(), workers: { connect: [{ id: worker.id }] } });
    return { org, admin };
  },

  async validate(ctx) {
    const { admin } = ctx['BUG-0039'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const headers = { authorization: `Bearer ${token}` };
    // The local date, as the report reads it: toISOString() is yesterday between 00:00 and 05:30 IST (BUG-0055).
    const to = localDateKey();
    const from = localDateKey(new Date(Date.now() - 6 * 86_400_000));
    const report = await ctx.app.inject({ method: 'GET', url: `/api/analytics/report?from=${from}&to=${to}`, headers });
    if (report.statusCode !== 200) return { ok: false, detail: `GET /api/analytics/report answered ${report.statusCode}` };
    const { topWorkers = [], topSupervisors = [] } = report.json();
    if (!topWorkers.length || !topSupervisors.length) return { ok: false, detail: 'the scenario inspection is not in the report' };
    const analytics = fs.readFileSync(path.join(PUBLIC_DIR, 'admin-analytics.html'), 'utf8');
    for (const [fn, v, row] of [['renderWorkers', 'w', topWorkers[0]], ['renderSupervisors', 's', topSupervisors[0]]]) {
      const read = fieldsRead(analytics, fn, v);
      if (!read) return { ok: false, detail: `admin-analytics.html has no ${fn}()` };
      const missing = read.filter((k) => !(k in row));
      if (missing.length) return { ok: false, detail: `${fn} reads ${missing.join(', ')}, which the API does not send` };
    }
    const log = await ctx.app.inject({ method: 'GET', url: `/api/electrical-inspections?from=${to}&limit=100`, headers });
    const dashboard = fs.readFileSync(path.join(PUBLIC_DIR, 'admin-dashboard.html'), 'utf8');
    const listKey = (dashboard.match(/function loadInspectionLog[\s\S]*?var records = data\.([a-zA-Z_]+)/) || [])[1];
    if (!listKey || !Array.isArray(log.json()[listKey])) return { ok: false, detail: `the dashboard reads data.${listKey}, which GET /api/electrical-inspections does not send` };
    return { ok: true, detail: 'the bars and the log read fields the APIs send' };
  }
};
