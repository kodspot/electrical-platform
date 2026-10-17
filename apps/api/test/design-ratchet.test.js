'use strict';

// scripts/design-ratchet.js — the QA-2 design ratchets (colour literals, colour contrast).
// A fixture repository in a temp directory; no database.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dr = require('../scripts/design-ratchet');

let root, baselineFile;
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const setBaseline = (b) => fs.writeFileSync(baselineFile, JSON.stringify(b));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  baselineFile = path.join(root, 'e2e', 'design-baseline.json');
  // 2 literals in the page, 1 in the stylesheet; the token blocks and selectors don't count.
  write('apps/api/public/page.html', '<style>:root{--a:#123456} .x{color:#fff;border:1px solid rgba(0,0,0,.1)} #add{}</style><a href="#">&#x2192;</a>');
  write('apps/api/public/css/site.css', '[data-theme="dark"]{--bg:#000} .y{background:hsl(10, 50%, 50%)} .z{color:var(--a)}');
  write('e2e/design-baseline.json', '{}');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('design ratchet: colour literals', () => {
  it('counts hex/rgb()/hsl() in value position, not token definitions, selectors, href="#" or entities', () => {
    assert.strictEqual(dr.countIn('a{color:#fff} #add{} #abc {x} <a href="#">&#x2192;</a> x{background: rgba(0,0,0,.1)}'), 2);
    assert.strictEqual(dr.countIn(':root{--a:#123456} :root[data-theme="dark"]{--a:#000} y{--d:#111;border:1px solid #222}'), 1);
    assert.deepStrictEqual(dr.countColourLiterals(root), { count: 3, files: { 'apps/api/public/css/site.css': 1, 'apps/api/public/page.html': 2 } });
  });

  it('passes at the baseline, fails at baseline + 1, reports "better" below it', () => {
    setBaseline({ colourLiterals: 3, colourContrastNodes: 0 });
    assert.strictEqual(dr.ratchet('colours', { root, baselineFile }).status, 'ok');
    write('apps/api/public/page.html', '<style>.x{color:#fff;border:1px solid rgba(0,0,0,.1);background:#eee}</style>');
    assert.deepStrictEqual(dr.ratchet('colours', { root, baselineFile }), { name: 'colour literals', count: 4, baseline: 3, status: 'worse' });
    write('apps/api/public/page.html', '<style>.x{color:var(--a)}</style>');
    assert.strictEqual(dr.ratchet('colours', { root, baselineFile }).status, 'better');
  });

  it('--update only ever lowers the baseline', () => {
    setBaseline({ colourLiterals: 5, colourContrastNodes: 7 });
    assert.strictEqual(dr.lowerBaseline('colourLiterals', 4, baselineFile), true);
    assert.strictEqual(dr.lowerBaseline('colourLiterals', 9, baselineFile), false);
    assert.deepStrictEqual(dr.readBaseline(baselineFile), { colourLiterals: 4, colourContrastNodes: 7 });
  });
});

describe('design ratchet: colour contrast', () => {
  const summary = (nodes) => ({ pages: nodes.map((n, i) => ({ page: `p${i}`, axeRules: { 'color-contrast': n, 'link-in-text-block': 9 } })) });

  it('sums axe color-contrast nodes over every page view (other rules ignored)', () => {
    assert.strictEqual(dr.contrastCount(summary([2, 0, 3])), 5);
    assert.strictEqual(dr.contrastCount({ pages: [{ page: 'x' }] }), 0);
  });

  it('passes at the baseline and fails at baseline + 1', () => {
    setBaseline({ colourLiterals: 0, colourContrastNodes: 5 });
    const file = path.join(root, 'summary.json');
    fs.writeFileSync(file, JSON.stringify(summary([2, 3])));
    assert.strictEqual(dr.ratchet('contrast', { summaryFile: file, baselineFile }).status, 'ok');
    fs.writeFileSync(file, JSON.stringify(summary([2, 4])));
    assert.strictEqual(dr.ratchet('contrast', { summaryFile: file, baselineFile }).status, 'worse');
  });
});

describe('design ratchet: the real repository', () => {
  it('the committed baseline holds today (the CLI exits 0)', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'design-ratchet.js'), 'colours'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /design ratchet: colour literals \d+ \(baseline \d+/);
  });
});
