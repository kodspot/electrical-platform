'use strict';

/**
 * Design ratchets (QA-2): two counts that may only go down. Each fails only when its count is
 * WORSE than the committed baseline (e2e/design-baseline.json); lowering a count is allowed and
 * `--update` writes the new, lower number. A baseline is never raised by this script.
 *
 *   colour literals   hard-coded colours (hex, rgb()/rgba(), hsl()/hsla()) in
 *                     apps/api/public/**\/*.html and apps/api/public/css/**, outside the
 *                     `:root { … }` design-token blocks. Static: runs in `npm run ci` (ci-validate).
 *   colour contrast   axe "color-contrast" violation nodes summed over every page and viewport
 *                     of an e2e run (e2e/reports/e2e-summary.json, pages[].axeRules). Runs in
 *                     e2e.yml after the suite.
 *
 * Usage (apps/api):
 *   node scripts/design-ratchet.js colours [--update]
 *   node scripts/design-ratchet.js contrast <e2e-summary.json> [--update]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const BASELINE_FILE = path.join(ROOT, 'e2e', 'design-baseline.json');

// A colour in value position: after ':', whitespace, '(' or ',' — never in a selector such as
// `#sv-nav` or `#add {`, an `href="#"`, or an `&#x2192;` entity.
const COLOUR = /(?<=[\s:(,])(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])(?!\s*\{)|(?:rgba?|hsla?)\(\s*[\d.]+)/g;
// Design-token definitions are where colour literals belong: the `:root { … }` blocks, and any
// custom property (`--primary: #1E40AF;`), e.g. the `[data-theme="dark"] { … }` token block.
const ROOT_BLOCK = /:root(?:\[[^\]]*\])?(?::not\([^)]*\))?\s*\{[^{}]*\}/g;
const TOKEN_DEF = /--[\w-]+\s*:[^;{}]*/g;

function listFiles(dir, re, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

/** Colour literals in one source text, outside the design-token definitions. */
function countIn(text) {
  return (text.replace(ROOT_BLOCK, '').replace(TOKEN_DEF, '').match(COLOUR) || []).length;
}

/** Every page and stylesheet under apps/api/public: { count, files: { rel: n } } (n > 0 only). */
function countColourLiterals(root = ROOT) {
  const pub = path.join(root, 'apps', 'api', 'public');
  const files = [
    ...listFiles(pub, /\.html$/).filter((f) => path.dirname(f) === pub || !/[\\/]css[\\/]/.test(f)),
    ...listFiles(path.join(pub, 'css'), /\.css$/)
  ];
  const byFile = {};
  let count = 0;
  for (const f of files.sort()) {
    const n = countIn(fs.readFileSync(f, 'utf8'));
    if (n) byFile[path.relative(root, f).replace(/\\/g, '/')] = n;
    count += n;
  }
  return { count, files: byFile };
}

/** axe color-contrast nodes over every page view of an e2e summary. */
function contrastCount(summary) {
  return (summary.pages || []).reduce((n, p) => n + ((p.axeRules && p.axeRules['color-contrast']) || 0), 0);
}

/** ok (same), better (lower: may be ratcheted down), worse (higher: fails). */
function compare(count, baseline) {
  return count > baseline ? 'worse' : count < baseline ? 'better' : 'ok';
}

function readBaseline(file = BASELINE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Lower one key of the baseline file (never raise it). Returns true when it changed. */
function lowerBaseline(key, count, file = BASELINE_FILE) {
  const b = readBaseline(file);
  if (count >= b[key]) return false;
  b[key] = count;
  fs.writeFileSync(file, `${JSON.stringify(b, null, 2)}\n`);
  return true;
}

const KEYS = { colours: 'colourLiterals', contrast: 'colourContrastNodes' };
const LABELS = { colours: 'colour literals', contrast: 'colour contrast (axe nodes)' };

/** Run one ratchet: { name, count, baseline, status }. */
function ratchet(which, { summaryFile, root = ROOT, baselineFile = BASELINE_FILE } = {}) {
  const count = which === 'colours'
    ? countColourLiterals(root).count
    : contrastCount(JSON.parse(fs.readFileSync(summaryFile, 'utf8')));
  const baseline = readBaseline(baselineFile)[KEYS[which]];
  return { name: LABELS[which], count, baseline, status: compare(count, baseline) };
}

if (require.main === module) {
  const [which, maybeFile] = process.argv.slice(2);
  const update = process.argv.includes('--update');
  if (!KEYS[which] || (which === 'contrast' && (!maybeFile || maybeFile.startsWith('--')))) {
    console.error('usage: design-ratchet.js colours [--update] | contrast <e2e-summary.json> [--update]');
    process.exit(2);
  }
  const r = ratchet(which, { summaryFile: maybeFile });
  if (r.status === 'worse') {
    console.error(`✗ design ratchet: ${r.name} ${r.count} > baseline ${r.baseline}. Use a design token (var(--…)) or fix the contrast; the baseline may only go down.`);
    if (which === 'colours') {
      for (const [f, n] of Object.entries(countColourLiterals().files)) console.error(`    ${n}\t${f}`);
    }
    process.exit(1);
  }
  if (r.status === 'better' && update) {
    lowerBaseline(KEYS[which], r.count);
    console.log(`✓ design ratchet: ${r.name} ${r.count} (baseline lowered from ${r.baseline})`);
  } else {
    console.log(`✓ design ratchet: ${r.name} ${r.count} (baseline ${r.baseline})${r.status === 'better' ? ' — lower: run with --update to lower the baseline' : ''}`);
  }
}

module.exports = { countIn, countColourLiterals, contrastCount, compare, ratchet, lowerBaseline, readBaseline, KEYS, BASELINE_FILE };
