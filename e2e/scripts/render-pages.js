'use strict';

/**
 * `npm run audit:render -- <label> [--before <label>]` (repository root).
 *
 * Screenshots of every page (desktop and Pixel 7) and axe results per element, rendered from
 * the current working tree, for UX reviews and audits (docs/AUDIT_PLAYBOOK.md).
 *
 * Runs Playwright in a temporary copy of the tree, so `--update-snapshots` can never rewrite
 * the committed Linux baselines. The database is run-e2e.js's own disposable container, so
 * only one e2e run can use its ports at a time.
 *
 * Output, in e2e/reports/render/<label>/ (git-ignored):
 *   chromium-desktop/<page>.png, chromium-mobile/<page>.png
 *   axe.json        every page's violations with their selectors
 *   summary.json    scripts/summarize.js output (counts per page and design numbers)
 *   changed.txt     with --before: the images that differ from that earlier render
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const label = args[0];
const beforeAt = args.indexOf('--before');
const before = beforeAt === -1 ? null : args[beforeAt + 1];
if (!label || label.startsWith('-') || !/^[\w.-]+$/.test(label)) {
  console.error('Usage: npm run audit:render -- <label> [--before <label>]');
  process.exit(2);
}

const OUT_ROOT = path.join(REPO, 'e2e', 'reports', 'render');
const OUT = path.join(OUT_ROOT, label);
const COPY = fs.mkdtempSync(path.join(os.tmpdir(), 'kodspot-render-'));
const LINKS = [path.join('apps', 'api', 'node_modules'), path.join('e2e', 'node_modules')];

function copyTree() {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr}`);
  for (const file of res.stdout.split('\0').filter(Boolean)) {
    if (path.basename(file) === '.env') continue; // never copy a real environment file
    const from = path.join(REPO, file);
    if (!fs.existsSync(from)) continue; // deleted in the working tree
    fs.mkdirSync(path.dirname(path.join(COPY, file)), { recursive: true });
    fs.copyFileSync(from, path.join(COPY, file));
  }
  for (const link of LINKS) fs.symlinkSync(path.join(REPO, link), path.join(COPY, link), 'junction');
}

/** Unlinks the node_modules links first, so that removing the copy can never reach the real ones. */
function removeCopy() {
  for (const link of LINKS) {
    const p = path.join(COPY, link);
    try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* not created */ } }
  }
  if (LINKS.some((link) => fs.existsSync(path.join(COPY, link)))) {
    console.error(`[render] left ${COPY} in place: a node_modules link could not be removed`);
    return;
  }
  fs.rmSync(COPY, { recursive: true, force: true });
}

/** Collects the axe attachment of every page from Playwright's JSON report. */
function extractAxe(reportFile) {
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const pages = [];
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) for (const t of spec.tests || []) for (const r of t.results || []) {
      for (const a of r.attachments || []) {
        if (!/^axe-.*\.json$/.test(a.name)) continue;
        const body = a.body ? Buffer.from(a.body, 'base64').toString('utf8')
          : (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path, 'utf8') : null);
        if (!body) continue;
        const j = JSON.parse(body);
        if (j.violations.length) pages.push({ page: j.page, project: t.projectName, violations: j.violations });
      }
    }
  };
  for (const s of report.suites || []) walk(s);
  return pages;
}

function changedSince(earlier) {
  const a = path.join(OUT_ROOT, earlier);
  const changed = [];
  for (const view of fs.readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const f of fs.readdirSync(path.join(OUT, view))) {
      const x = path.join(a, view, f);
      if (!fs.existsSync(x) || !fs.readFileSync(x).equals(fs.readFileSync(path.join(OUT, view, f)))) changed.push(`${view}/${f}`);
    }
  }
  return changed;
}

let status = 1;
try {
  copyTree();
  const run = spawnSync(process.execPath, ['e2e/scripts/run-e2e.js', 'tests/visual-a11y.spec.js', '--update-snapshots'], { cwd: COPY, stdio: 'inherit' });
  status = run.status === null ? 1 : run.status;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const shots = path.join(COPY, 'e2e', 'tests', '__screenshots__', process.platform);
  if (fs.existsSync(shots)) fs.cpSync(shots, OUT, { recursive: true });

  const report = path.join(COPY, 'e2e', 'reports', 'results.json');
  if (fs.existsSync(report)) {
    const axe = extractAxe(report);
    fs.writeFileSync(path.join(OUT, 'axe.json'), JSON.stringify(axe, null, 1));
    const nodes = {};
    for (const p of axe) for (const v of p.violations) nodes[v.id] = (nodes[v.id] || 0) + v.nodes;
    console.log(`[render] axe nodes by rule: ${JSON.stringify(nodes)}`);
    spawnSync(process.execPath, ['scripts/summarize.js', 'reports/results.json', path.join(OUT, 'summary.json')], { cwd: path.join(COPY, 'e2e'), stdio: 'ignore' });
  }
  if (before) {
    const changed = changedSince(before);
    fs.writeFileSync(path.join(OUT, 'changed.txt'), changed.join('\n') + '\n');
    console.log(`[render] ${changed.length} image(s) differ from "${before}"`);
  }
  console.log(`[render] output in ${path.relative(REPO, OUT)}`);
} finally {
  removeCopy();
}
process.exit(status);
