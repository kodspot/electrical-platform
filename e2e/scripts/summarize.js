'use strict';

/**
 * Turn Playwright's JSON report (reports/results.json) into the Quality-page summary
 * (reports/e2e-summary.json) that e2e.yml posts to POST /api/qa/runs with source 'e2e'.
 *
 *   status    passed | failed | passed_with_not_executed (the same words as the API suite)
 *   counts    tests, pass, fail, cancelled, skipped, todo, flaky
 *   journeys  every non-visual test: { title, project, status, durationMs }
 *   pages     the design/a11y checks: { page, project, status, visual, axe: {critical, …} }
 *   explorer  tests/explorer.spec.js, per project (desktop, mobile): one row per role × page
 *             { role, page, status, failed, allowed, links, linkFailures, tabs }, plus the
 *             forbidden matrix and the allow-list entries that no longer reproduce
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

const PROJECT_KEY = { 'chromium-desktop': 'desktop', 'chromium-mobile': 'mobile' };
const join = (xs) => [...new Set(xs)].join(', ');

/**
 * The explorer's `explorer` annotations → rows per project. Each visit annotation is
 * { role, page, kind: open|tab|link|forbidden, from, failed: [checks], allowed: [{check, finding}] };
 * links and tabs are counted on the page they were found on. Flat arrays of ≤ 50 rows each, so
 * they survive the ingest's trimming (qa.js trimDetails: depth ≤ 5, 50 items by default).
 */
function explorerSection(rows, allowlist) {
  const out = { desktop: [], mobile: [], forbidden: [], allowlist: { entries: allowlist.length, unused: [] } };
  const hit = [];
  const visited = new Set();
  for (const { project, status, visits } of rows) {
    const key = PROJECT_KEY[project] || project;
    if (!out[key]) out[key] = [];
    for (const v of visits) {
      if (v.kind !== 'forbidden') visited.add(`${v.role}|${v.page}`);
      for (const a of v.allowed || []) hit.push({ role: v.role, page: v.page, check: a.check });
    }
    const open = visits.find((v) => v.kind === 'open');
    if (open) {
      const own = visits.filter((v) => v.kind !== 'forbidden');
      const links = own.filter((v) => v.kind === 'link');
      out[key].push({
        role: open.role,
        page: open.page,
        status,
        failed: join(own.flatMap((v) => v.failed || [])),
        allowed: join(own.flatMap((v) => (v.allowed || []).map((a) => a.finding))),
        links: links.length,
        linkFailures: links.filter((v) => (v.failed || []).length).length,
        tabs: own.filter((v) => v.kind === 'tab').length
      });
    }
    const forb = visits.filter((v) => v.kind === 'forbidden');
    if (forb.length) {
      out.forbidden.push({ project: key, role: forb[0].role, checked: forb.length, shown: forb.filter((v) => (v.failed || []).length).map((v) => v.page).join(', '), status });
    }
  }
  // "remove me": an entry whose role/page was explored in this run but that matched nothing.
  const fits = (e, role, page) => (e.role === '*' || e.role === role) && (e.page === '*' || e.page === page);
  for (const e of allowlist) {
    const explored = [...visited].some((k) => { const [role, page] = k.split('|'); return fits(e, role, page); });
    const matched = hit.some((h) => fits(e, h.role, h.page) && e.check === h.check);
    if (explored && !matched) out.allowlist.unused.push(`${e.finding} ${e.role}/${e.page} ${e.check}`);
  }
  return out;
}

function readAllowlist() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'explorer-allowlist.json'), 'utf8')).entries || []; } catch { return []; }
}

function summarize(report, allowlist = readAllowlist()) {
  const tests = collectTests(report, '', []);
  const explorerRows = [];
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

    if (/explorer\.spec/.test(file)) {
      // The last attempt's visits only (a retried test records every attempt).
      const visits = (last.annotations || []).filter((a) => a.type === 'explorer').map((a) => JSON.parse(a.description));
      explorerRows.push({ project: test.projectName, status, visits });
    } else if (/visual-a11y\.spec/.test(file)) {
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
  const summary = { status, counts, durationMs, journeys, pages, failures };
  if (explorerRows.length) summary.explorer = explorerSection(explorerRows, allowlist);
  return summary;
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
  if (summary.explorer) {
    const rows = [...summary.explorer.desktop, ...summary.explorer.mobile];
    console.log(`[e2e] explorer: ${rows.length} role × page × viewport, ${rows.filter((r) => r.status !== 'passed').length} failed, ` +
      `${rows.filter((r) => r.allowed).length} with allow-listed findings`);
    for (const u of summary.explorer.allowlist.unused) console.log(`[e2e] explorer allow-list: remove me — ${u} no longer reproduces`);
  }
}

module.exports = { summarize };
