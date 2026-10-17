'use strict';

/**
 * BUG-0012 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { createTestOrg, createTestUser, createTestLocation } = require('../factories');

const PAGE = path.join(__dirname, '..', '..', 'public', 'admin-analytics.html');

// Fields the page may read although the API does not send them, because it shows them
// guarded ("—" / a computed fallback) rather than raw.
const OPTIONAL = {
  summary: ['overallCompletionRate', 'prevTickets'],
  location: ['completionRate', 'expected', 'hasSchedule']
};

/** The fields `<v>.x` read inside one function of the page's inline script. */
function fieldsRead(src, fnName, v) {
  const start = src.indexOf(`function ${fnName}(`);
  if (start < 0) throw new Error(`${fnName} not found in admin-analytics.html`);
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end < 0 ? undefined : end);
  return [...new Set([...body.matchAll(new RegExp(`\\b${v}\\.(\\w+)`, 'g'))].map((m) => m[1]))];
}

module.exports = {
  id: 'BUG-0012',
  title: 'Admin analytics showed "undefined" for inspection records, flagged records and the location breakdown',
  description: 'admin-analytics.html read summary.totalRecords / flaggedRecords and locationBreakdown[].cleaned / expected / completionRate, names the API (GET /api/analytics/report) does not send — it sends totalInspections, flaggedInspections and inspections. The cards and the table printed "undefined" and "undefined%". Found by the QA-2 visual baselines.',
  module: 'ele',
  category: 'ui',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'QA-2 visual baselines (2026-10-17); fixed 2026-10-18',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-18',
  rootCause: 'The analytics page kept the field names of an older report shape; the API had been renamed (inspections) and never sent per-location schedule data.',
  expectedBehavior: 'Every field the page renders unguarded exists in the API response; Expected and Completion show "—" when the API sends no schedule data.',
  brokenBehavior: 'Inspection Records, Flagged Records, Inspected and Expected showed "undefined"; Completion showed "undefined%".',
  reproductionSteps: [
    'Sign in as an admin of an org with a location and no inspections.',
    'Open /{org}/ele/admin-analytics.',
    'Broken: "undefined" in the first two cards and the Location Breakdown. Fixed: 0 and "—".'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › rawValue check (admin › admin-analytics)',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    await createTestLocation(org.id, { type: 'ROOM' });
    return { org, admin };
  },

  async validate(ctx) {
    const { admin } = ctx['BUG-0012'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/analytics/report?from=${from}&to=${to}`, headers: { authorization: `Bearer ${token}` } });
    if (res.statusCode !== 200) return { ok: false, detail: `GET /api/analytics/report answered ${res.statusCode}` };
    const data = res.json();
    const src = fs.readFileSync(PAGE, 'utf8');
    const summaryKeys = new Set(Object.keys(data.summary || {}));
    const locationKeys = new Set(Object.keys((data.locationBreakdown || [])[0] || {}));
    if (!locationKeys.size) return { ok: false, detail: 'the scenario org has a location, but locationBreakdown is empty' };
    const missing = [
      ...fieldsRead(src, 'renderSummary', 's').filter((k) => !summaryKeys.has(k) && !OPTIONAL.summary.includes(k)).map((k) => `summary.${k}`),
      ...fieldsRead(src, 'renderLocTable', 'l').filter((k) => !locationKeys.has(k) && !OPTIONAL.location.includes(k)).map((k) => `locationBreakdown[].${k}`)
    ];
    if (/data\.summary\.totalRecords/.test(src)) missing.push('summary.totalRecords (renderShifts total)');
    if (missing.length) return { ok: false, detail: `the page reads fields the API does not send: ${missing.join(', ')}` };
    return { ok: true, detail: 'every analytics field the page renders unguarded exists in GET /api/analytics/report' };
  }
};
