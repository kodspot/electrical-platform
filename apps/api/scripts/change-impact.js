'use strict';

/**
 * Change impact report: which pages, API routes and data a change affects, and which tests
 * cover each of them. Deterministic (no AI, no network): it reads only the changed file list
 * and this repository. Report-only — it never fails a build. [QA-2]
 *
 *   public/<page>.html                 → that page
 *   public/js/<f>.js, public/css/<f>   → every page that loads it (app.js, the design system: all)
 *   public/sw.js                       → every page (service worker)
 *   src/routes/<f>.js                  → its routes (checked against docs/reference/routes.generated.md)
 *                                        and the pages that call them
 *   src/{services,lib,middleware,plugins}/<f>.js
 *                                      → the routes of every route file that requires it
 *   prisma/schema.prisma, prisma/migrations/<m>/
 *                                      → the data model / that migration
 *   tests, e2e/, .github/, docs/, *.md → listed, no runtime impact
 *
 * Covering tests per item: the browser journeys, the explorer, the visual checks
 * (e2e/tests/), the API suite (apps/api/test/) and the bug registry (scenarios/bugs/), found by
 * searching them for the page name or the route path. An item no test mentions is
 * "changed but not covered".
 *
 * Usage (repository root or apps/api):
 *   node apps/api/scripts/change-impact.js --base <ref> [--head <ref>] [--md out.md] [--json out.json]
 *   node apps/api/scripts/change-impact.js --files a,b,c   (no git; for tests)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const API = 'apps/api';
const MARKER = '<!-- change-impact -->';
const MAX_ROWS = 60;

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

/** Every file under `dir` (relative to root) whose name matches `re`. */
function walk(root, dir, re, out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === '__screenshots__') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(root, rel, re, out);
    else if (re.test(e.name)) out.push(rel);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A route path as a regex over source text: params match an interpolation or an id. */
function routeRegex(p) {
  return new RegExp(p.split(/(:\w+)/).map((part) => (part.startsWith(':') ? "[^/'\"`\\s?]+" : escapeRe(part))).join('') + "(?![\\w-])");
}

/** The repository facts the mapping needs, read once. */
function indexRepo(root) {
  const pagesDir = `${API}/public`;
  const pages = (fs.existsSync(path.join(root, pagesDir)) ? fs.readdirSync(path.join(root, pagesDir)) : [])
    .filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort();
  const pageSource = Object.fromEntries(pages.map((p) => [p, read(root, `${pagesDir}/${p}.html`) || '']));

  // Route index: "| GET | `/api/x` |" rows.
  const index = read(root, 'docs/reference/routes.generated.md') || '';
  const known = new Set([...index.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`));

  // Route file → its routes (all API route files are registered under /api in index.js).
  const routeFiles = {};
  for (const rel of walk(root, `${API}/src/routes`, /\.js$/)) {
    const src = read(root, rel) || '';
    const prefix = /pages\.js$/.test(rel) ? '' : '/api';
    const routes = [];
    for (const m of src.matchAll(/\bfastify\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
      const r = `${m[1].toUpperCase()} ${prefix}${m[2]}`;
      if (!known.size || known.has(r)) routes.push(r);
    }
    routeFiles[rel] = [...new Set(routes)];
  }

  // Shared server modules → the route files that require them (one level).
  const requiredBy = {};
  for (const rel of Object.keys(routeFiles)) {
    const src = read(root, rel) || '';
    for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])).replace(/(\.js)?$/, '.js');
      (requiredBy[target] = requiredBy[target] || []).push(rel);
    }
  }

  // Test sources, by kind.
  const tests = [];
  const add = (kind, rel) => tests.push({ kind, ref: rel, src: read(root, rel) || '' });
  for (const rel of walk(root, 'e2e/tests', /\.spec\.js$/)) {
    add(/explorer\.spec/.test(rel) ? 'explorer' : /visual/.test(rel) ? 'visual' : 'journey', rel);
  }
  for (const rel of walk(root, `${API}/test`, /\.js$/)) add('unit', rel);
  for (const rel of walk(root, `${API}/scenarios/bugs`, /^bug-\d+.*\.js$/)) add('bug', rel);

  return { pages, pageSource, routeFiles, requiredBy, tests };
}

/** Which tests mention this page / route. The explorer covers every page of the route table. */
function coverageFor(repo, item) {
  const hits = [];
  for (const t of repo.tests) {
    if (item.kind === 'page') {
      const named = new RegExp(`['"\`/]${escapeRe(item.id)}(?![\\w-])`).test(t.src);
      // The explorer and (once it reads the explorer's role map) the visual checks derive
      // their page list from the route table, so they cover every page.
      const allPages = (t.kind === 'explorer' || (t.kind === 'visual' && /support\/explorer/.test(t.src)));
      if (named || allPages) hits.push({ type: t.kind, ref: t.ref });
    } else if (item.kind === 'route') {
      const p = item.id.split(' ')[1];
      if (routeRegex(p).test(t.src)) hits.push({ type: t.kind, ref: t.ref });
    } else if (item.kind === 'data') {
      if (t.kind === 'unit' && /schema-drift/.test(t.ref)) hits.push({ type: t.kind, ref: t.ref });
    }
  }
  return hits;
}

/** Pages whose own source calls this API route (by its path without /api). */
function pagesCalling(repo, route) {
  const p = route.split(' ')[1];
  if (!p.startsWith('/api/')) return [];
  const re = routeRegex(p.slice(4));
  const staticPrefix = p.slice(4).split('/:')[0];
  return repo.pages.filter((pg) => re.test(repo.pageSource[pg]) || (staticPrefix.length > 1 && repo.pageSource[pg].includes(`'${staticPrefix}`)));
}

/**
 * @param {string[]} files — changed paths, relative to the repository root
 * @param {string} [root]
 * @returns {{ files: number, items: object[], other: object[], uncovered: object[] }}
 */
function analyze(files, root = ROOT) {
  const repo = indexRepo(root);
  const items = new Map();
  const other = [];
  const addItem = (kind, id, because, extra = {}) => {
    const key = `${kind}|${id}`;
    if (!items.has(key)) items.set(key, { kind, id, because: [], ...extra });
    const it = items.get(key);
    if (!it.because.includes(because)) it.because.push(because);
  };
  const assetPages = (asset) => repo.pages.filter((p) => repo.pageSource[p].includes(asset));

  for (const raw of files) {
    const f = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    let m;
    if ((m = /^apps\/api\/public\/([\w-]+)\.html$/.exec(f))) addItem('page', m[1], f);
    else if ((m = /^apps\/api\/public\/((?:js|css)\/[^?]+)$/.exec(f))) {
      const on = assetPages(`/${m[1]}`);
      for (const p of on) addItem('page', p, f);
      if (!on.length) other.push({ file: f, note: 'loaded by no page' });
    } else if (f === 'apps/api/public/sw.js') {
      for (const p of repo.pages) addItem('page', p, f);
    } else if (/^apps\/api\/public\//.test(f)) other.push({ file: f, note: 'static asset' });
    else if ((m = /^apps\/api\/src\/routes\/[\w-]+\.js$/.exec(f))) {
      const routes = repo.routeFiles[f] || [];
      for (const r of routes) addItem('route', r, f);
      if (!routes.length) other.push({ file: f, note: 'no routes found in this file' });
    } else if (/^apps\/api\/src\/(services|lib|middleware|plugins)\/[\w./-]+\.js$/.test(f)) {
      const users = repo.requiredBy[f] || [];
      for (const rf of users) for (const r of repo.routeFiles[rf] || []) addItem('route', r, f);
      if (!users.length) other.push({ file: f, note: 'shared server code (used outside route files, or app-wide)' });
    } else if (f === 'apps/api/prisma/schema.prisma') addItem('data', 'data model (schema.prisma)', f);
    else if ((m = /^apps\/api\/prisma\/migrations\/([^/]+)\//.exec(f))) addItem('data', `migration ${m[1]}`, f);
    else if (/^(e2e\/|apps\/api\/test\/|apps\/api\/scenarios\/)/.test(f)) other.push({ file: f, note: 'tests' });
    else if (/^\.github\//.test(f)) other.push({ file: f, note: 'CI' });
    else if (/^docs\/|\.md$/.test(f)) other.push({ file: f, note: 'docs' });
    else other.push({ file: f, note: 'not mapped' });
  }

  const list = [...items.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  for (const it of list) {
    it.coveredBy = coverageFor(repo, it);
    it.covered = it.coveredBy.length > 0;
    if (it.kind === 'route') it.pages = pagesCalling(repo, it.id);
  }
  return { files: files.length, items: list, other, uncovered: list.filter((i) => !i.covered) };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
function coverageCell(it) {
  if (!it.covered) return '**not covered**';
  const by = {};
  for (const c of it.coveredBy) (by[c.type] = by[c.type] || []).push(path.posix.basename(c.ref));
  return Object.entries(by).map(([type, refs]) => `${type} (${refs.length > 3 ? `${refs.slice(0, 3).join(', ')}, +${refs.length - 3}` : refs.join(', ')})`).join('; ');
}

function table(rows, head, fn) {
  if (!rows.length) return [];
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows.slice(0, MAX_ROWS)) out.push(`| ${fn(r).map(cell).join(' | ')} |`);
  if (rows.length > MAX_ROWS) out.push(`| … and ${rows.length - MAX_ROWS} more | |`);
  return out;
}

/** The PR comment. */
function toMarkdown(result, { base = '', head = '' } = {}) {
  const by = (k) => result.items.filter((i) => i.kind === k);
  const pages = by('page');
  const routes = by('route');
  const data = by('data');
  const short = (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);
  const lines = [MARKER, `## Change impact${head ? ` — \`${short(head)}\`` : ''}${base ? ` vs \`${short(base)}\`` : ''}`, ''];
  lines.push(`${result.files} file(s) changed → **${pages.length} page(s)**, **${routes.length} API route(s)**, **${data.length} data change(s)**. ` +
    (!result.items.length ? 'No page, API route or data change.'
      : result.uncovered.length ? `⚠️ **${result.uncovered.length} changed but not covered.**` : 'Every affected item is covered by a test.'));
  lines.push('', '_Deterministic map from the changed files (`apps/api/scripts/change-impact.js`); report-only, never fails the build._');
  if (result.uncovered.length) {
    lines.push('', '### ⚠️ Changed but not covered', '');
    for (const it of result.uncovered.slice(0, MAX_ROWS)) lines.push(`- ${it.kind} \`${it.id}\` — changed by ${it.because.map((b) => `\`${b}\``).join(', ')}`);
  }
  if (pages.length) lines.push('', '### Pages', '', ...table(pages, ['Page', 'Changed by', 'Covered by'], (r) => [`\`${r.id}\``, r.because.join(', '), coverageCell(r)]));
  if (routes.length) lines.push('', '### API routes', '', ...table(routes, ['Route', 'Changed by', 'Pages calling it', 'Covered by'], (r) => [`\`${r.id}\``, r.because.join(', '), r.pages.join(', ') || '—', coverageCell(r)]));
  if (data.length) lines.push('', '### Data', '', ...table(data, ['Change', 'File', 'Covered by'], (r) => [r.id, r.because.join(', '), coverageCell(r)]));
  if (result.other.length) lines.push('', '### Other files', '', ...table(result.other, ['File', 'Kind'], (r) => [`\`${r.file}\``, r.note]));
  return lines.join('\n') + '\n';
}

/** The QA ingest payload's summary (POST /api/qa/runs, source 'impact'). */
function toSummary(result) {
  const counts = { tests: result.items.length, pass: result.items.length - result.uncovered.length, fail: result.uncovered.length, cancelled: 0, skipped: 0, todo: 0 };
  return {
    status: result.uncovered.length ? 'not_covered' : 'covered',
    counts,
    durationMs: null,
    files: result.files,
    items: result.items.slice(0, 50).map((i) => ({ kind: i.kind, id: i.id, covered: i.covered, coveredBy: [...new Set(i.coveredBy.map((c) => c.type))].join(', '), pages: (i.pages || []).slice(0, 10).join(', ') })),
    uncovered: result.uncovered.slice(0, 50).map((i) => `${i.kind} ${i.id}`),
    other: result.other.slice(0, 50).map((o) => `${o.file} (${o.note})`)
  };
}

function changedFiles(base, head = 'HEAD') {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const files = opt('files') !== undefined ? opt('files').split(',').filter(Boolean) : changedFiles(opt('base') || 'origin/main', opt('head') || 'HEAD');
    const result = analyze(files);
    const md = toMarkdown(result, { base: opt('base'), head: opt('head') });
    if (opt('md')) fs.writeFileSync(opt('md'), md); else process.stdout.write(md);
    if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(toSummary(result), null, 2));
    console.error(`[impact] ${result.files} file(s): ${result.items.length} affected item(s), ${result.uncovered.length} not covered`);
  } catch (err) {
    // Report-only: a failure here must never fail the build.
    console.error(`[impact] could not compute the report: ${err.message.split('\n')[0]}`);
  }
}

module.exports = { analyze, toMarkdown, toSummary, routeRegex, MARKER };
