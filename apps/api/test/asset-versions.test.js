'use strict';

// /js and /css are cached by browsers for a day (Caddy max-age=86400) and served cache-first by
// both service workers, so a changed shared script reaches people only when its ?v= changes.
// Every page and both service workers' precache lists must name the same version: a page left
// on the old one keeps running the old script. (2026-10-26: the branch's app.js fixes —
// escaping, retries, sessions — were still behind ?v=14.)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const versionsOf = (src, file) => [...src.matchAll(new RegExp(`/${file.replace('.', '\\.')}\\?v=(\\d+)`, 'g'))].map((m) => m[1]);

describe('shared scripts and styles are referenced at one version', () => {
  const sources = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8')])
    .concat([['sw.js', fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8')], ['pages.js (module service worker)', fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'pages.js'), 'utf8')]]);

  for (const file of ['js/app.js', 'js/offline-sync.js', 'css/design-system.css']) {
    it(`${file}: one ?v= everywhere, service workers included`, () => {
      const seen = new Map();
      for (const [name, src] of sources) for (const v of versionsOf(src, file)) seen.set(v, [...(seen.get(v) || []), name]);
      assert.ok(seen.size > 0, `${file} is referenced`);
      assert.strictEqual(seen.size, 1, `${file} at several versions: ${JSON.stringify(Object.fromEntries(seen))}`);
    });
  }
});
