'use strict';

// public/js/app.js's escaping helpers, run in a sandbox. Pages build markup from names an org
// admin types in (locations, electricians, templates, rules) and super-admins open those pages
// for any org, so:
//   - App.esc must be safe in element content AND inside a quoted attribute;
//   - App.escJs must be safe as a JS string argument of an inline handler (onclick="f('…')"),
//     which the browser HTML-decodes before it runs the code. [BUG-0028]

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

/** Loads app.js with a document stub whose innerHTML serialises text as browsers do (&, <, >, nbsp; quotes untouched). */
function loadApp() {
  const noop = () => {};
  const document = {
    addEventListener: noop,
    createElement() {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); }
      };
    }
  };
  const sandbox = { window: { addEventListener: noop }, document, navigator: {}, localStorage: { getItem: () => null }, location: { pathname: '/' } };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'), sandbox);
  return sandbox.window.App;
}

/** What the HTML parser hands over as the attribute's value: character references decoded. */
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const PAYLOADS = [
  'x" onmouseover="alert(1)',
  "x');alert(1);//",
  "x\\');alert(1);//",
  'x\\',
  '<img src=x onerror=alert(1)>',
  'line\nbreak sep',
  'O\'Brien & "Sons"',
  'Hostel A — Block 2'
];

describe('BUG-0028: App.esc / App.escJs are safe where pages use them', () => {
  const App = loadApp();

  it('App.esc leaves no character that can end a quoted attribute or open a tag, and round-trips', () => {
    for (const p of PAYLOADS) {
      const out = App.esc(p);
      assert.doesNotMatch(out, /["'<>]/, `esc(${JSON.stringify(p)}) = ${out}`);
      assert.strictEqual(decodeAttr(out), p);
    }
    assert.strictEqual(App.esc(''), '');
    assert.strictEqual(App.esc(null), '');
    assert.strictEqual(App.esc(undefined), '');
    assert.strictEqual(App.esc(42), '42');
  });

  it('App.escJs inside onclick="f(\'…\')" passes the exact text as one argument and runs nothing else', () => {
    assert.strictEqual(typeof App.escJs, 'function', 'App.escJs exists');
    for (const p of PAYLOADS) {
      const attrValue = `f('${App.escJs(p)}')`;
      assert.doesNotMatch(attrValue, /"/, 'nothing can end the double-quoted attribute early');
      const calls = [];
      let injected = false;
      vm.runInNewContext(decodeAttr(attrValue), { f: (arg) => calls.push(arg), alert: () => { injected = true; } });
      assert.strictEqual(injected, false, `escJs(${JSON.stringify(p)}) ran injected code`);
      assert.deepStrictEqual(calls, [p], `escJs(${JSON.stringify(p)}) changed the argument`);
    }
    assert.strictEqual(App.escJs(null), '');
    assert.strictEqual(App.escJs(undefined), '');
  });

  it('no page hands esc() output to an inline handler, or uses the old esc(…).replace(/\'/g, "\\\\\'") idiom', () => {
    const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => path.join(PUBLIC, f))
      .concat(fs.readdirSync(path.join(PUBLIC, 'js')).map((f) => path.join(PUBLIC, 'js', f)));
    const offenders = [];
    for (const file of pages) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/esc\((?:[^()]|\([^()]*\))*\)\.replace\(\/'\/g/.test(line) || /\bon[a-z]+="[^"]*\\''\s*\+\s*esc\(/.test(line)) {
          offenders.push(`${path.relative(PUBLIC, file)}:${i + 1}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [], 'use App.escJs for JS string arguments in inline handlers');
  });
});
