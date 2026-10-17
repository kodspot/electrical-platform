'use strict';

/**
 * Turn the production smoke's Playwright report (reports/prod-smoke-results.json) into the
 * Quality-page summary (reports/prod-smoke-summary.json) that prod-smoke.yml posts to
 * POST /api/qa/runs with source 'prod-smoke'.
 *
 *   status   passed | failed
 *   counts   tests, pass, fail, cancelled, skipped, todo, flaky
 *   checks   one row per check: { check, status, detail } (detail: first line of the failure)
 *   methods  every HTTP method the smoke requested, with counts — the read-only proof
 *            ({ GET: n, HEAD: n }; any other method is counted, aborted before it leaves the
 *            browser, and fails the run)
 *   readOnly true when nothing but GET/HEAD was requested
 *   target   the host checked (no path, no query)
 *
 * Usage: node scripts/prod-smoke-summary.js [results.json] [out.json]
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const input = process.argv[2] || path.join(DIR, 'reports', 'prod-smoke-results.json');
const output = process.argv[3] || path.join(DIR, 'reports', 'prod-smoke-summary.json');

const firstLine = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) || '';

function collect(suite, out) {
  for (const s of suite.suites || []) collect(s, out);
  for (const spec of suite.specs || []) for (const t of spec.tests || []) out.push({ spec, test: t });
  return out;
}

function summarize(report, target = null) {
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, flaky: 0 };
  const checks = [];
  const methods = {};
  for (const { spec, test } of collect(report, [])) {
    counts.tests++;
    const last = test.results[test.results.length - 1] || {};
    const status = test.status === 'expected' ? 'passed' : test.status === 'flaky' ? 'flaky' : test.status === 'skipped' ? 'skipped' : 'failed';
    if (status === 'passed') counts.pass++;
    else if (status === 'flaky') { counts.pass++; counts.flaky++; } else if (status === 'skipped') counts.skipped++;
    else counts.fail++;
    // Methods from every attempt: a retry sends requests too.
    for (const r of test.results) {
      for (const a of r.annotations || []) {
        if (a.type !== 'methods') continue;
        for (const [m, n] of Object.entries(JSON.parse(a.description))) methods[m] = (methods[m] || 0) + n;
      }
    }
    const err = firstLine((last.errors && last.errors[0] && last.errors[0].message) || (last.error && last.error.message));
    checks.push({ check: spec.title.slice(0, 120), status, detail: status === 'failed' ? err.slice(0, 300) : '' });
  }
  const readOnly = Object.keys(methods).every((m) => m === 'GET' || m === 'HEAD');
  const status = counts.fail > 0 || !readOnly ? 'failed' : 'passed';
  const durationMs = report.stats && typeof report.stats.duration === 'number' ? Math.round(report.stats.duration) : null;
  return { status, counts, durationMs, checks, methods, readOnly, target };
}

if (require.main === module) {
  if (!fs.existsSync(input)) {
    console.error(`[prod-smoke] no report at ${path.relative(DIR, input)}; nothing to summarize`);
    process.exit(1);
  }
  let target = null;
  try { target = new URL(process.env.PROD_SMOKE_URL).host; } catch { /* unset */ }
  const summary = summarize(JSON.parse(fs.readFileSync(input, 'utf8')), target);
  fs.writeFileSync(output, JSON.stringify(summary, null, 2));
  const c = summary.counts;
  console.log(`[prod-smoke] ${summary.status}: ${c.pass}/${c.tests} passed, ${c.fail} failed; methods requested: ` +
    `${Object.entries(summary.methods).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}${summary.readOnly ? ' (read-only)' : ' — NOT READ-ONLY'}`);
}

module.exports = { summarize };
