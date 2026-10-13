'use strict';

/**
 * Turn Playwright's JSON report (reports/results.json) into the Quality-page summary
 * (reports/e2e-summary.json) that e2e.yml posts to POST /api/qa/runs with source 'e2e'.
 *
 *   status    passed | failed | passed_with_not_executed (the same words as the API suite)
 *   counts    tests, pass, fail, cancelled, skipped, todo, flaky
 *   journeys  every non-visual test: { title, project, status, durationMs }
 *   pages     the design/a11y checks: { page, project, status, visual, axe: {critical, …} }
 *   failures  the first line of each failure, at most 20 (the server also scrubs JWT shapes)
 *
 * Usage: node scripts/summarize.js [results.json] [out.json]
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const input = process.argv[2] || path.join(DIR, 'reports', 'results.json');
const output = process.argv[3] || path.join(DIR, 'reports', 'e2e-summary.json');

const firstLine = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) || '';

function collectTests(suite, file, out) {
  for (const s of suite.suites || []) collectTests(s, s.file || file, out);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) out.push({ spec, test: t, file: spec.file || file });
  }
  return out;
}

function summarize(report) {
  const tests = collectTests(report, '', []);
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, flaky: 0 };
  const journeys = [];
  const pages = [];
  const failures = [];

  for (const { spec, test, file } of tests) {
    counts.tests++;
    const last = test.results[test.results.length - 1] || {};
    const outcome = test.status; // expected | unexpected | flaky | skipped
    const status = outcome === 'expected' ? 'passed' : outcome === 'flaky' ? 'flaky' : outcome === 'skipped' ? 'skipped' : 'failed';
    if (outcome === 'expected') counts.pass++;
    else if (outcome === 'flaky') { counts.pass++; counts.flaky++; }
    else if (outcome === 'skipped') counts.skipped++;
    else counts.fail++;
    const durationMs = test.results.reduce((n, r) => n + (r.duration || 0), 0);
    const annotations = [...(test.annotations || []), ...test.results.flatMap((r) => r.annotations || [])];
    const error = firstLine((last.errors && last.errors[0] && last.errors[0].message) || (last.error && last.error.message));

    if (/visual-a11y\.spec/.test(file)) {
      const page = spec.title.split(':')[0];
      const axeNote = annotations.find((a) => a.type === 'axe');
      const visualNote = annotations.find((a) => a.type === 'visual');
      const axe = {};
      if (axeNote) for (const m of axeNote.description.matchAll(/(critical|serious|moderate|minor) (\d+)/g)) axe[m[1]] = Number(m[2]);
      let visual = 'not-run';
      if (visualNote) visual = /^no baseline/.test(visualNote.description) ? 'no-baseline' : /^baseline written/.test(visualNote.description) ? 'updated' : 'compared';
      else if (/toHaveScreenshot|screenshot/i.test(error)) visual = 'diff';
      pages.push({ page, project: test.projectName, status, visual, axe });
    } else {
      journeys.push({ title: spec.title.slice(0, 160), project: test.projectName, status, durationMs });
    }
    if (status === 'failed' && failures.length < 20) {
      failures.push({ test: spec.title.slice(0, 160), file, status: last.status || 'failed', detail: error.slice(0, 300) });
    }
  }

  const status = counts.fail > 0 ? 'failed' : counts.skipped > 0 ? 'passed_with_not_executed' : 'passed';
  const durationMs = report.stats && typeof report.stats.duration === 'number' ? Math.round(report.stats.duration) : null;
  return { status, counts, durationMs, journeys, pages, failures };
}

if (require.main === module) {
  if (!fs.existsSync(input)) {
    console.error(`[e2e] no report at ${path.relative(DIR, input)}; nothing to summarize`);
    process.exit(1);
  }
  const summary = summarize(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(summary, null, 2));
  const c = summary.counts;
  console.log(`[e2e] ${summary.status}: ${c.pass}/${c.tests} passed, ${c.fail} failed, ${c.skipped} skipped, ${c.flaky} flaky; ` +
    `${summary.pages.filter((p) => p.visual === 'no-baseline').length} page(s) without a visual baseline`);
}

module.exports = { summarize };
