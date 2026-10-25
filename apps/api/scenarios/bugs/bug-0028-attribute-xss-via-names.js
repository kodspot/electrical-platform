'use strict';

/**
 * BUG-0028 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** public/js/app.js's App, loaded in a sandbox (document stub serialises text as browsers do). */
function loadApp() {
  const noop = () => {};
  const document = {
    addEventListener: noop,
    createElement() {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      };
    }
  };
  const sandbox = { window: { addEventListener: noop }, document, navigator: {}, localStorage: { getItem: () => null }, location: { pathname: '/' } };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8'), sandbox);
  return sandbox.window.App;
}

module.exports = {
  id: 'BUG-0028',
  title: 'Stored XSS: an org admin could plant script in names that ran for anyone opening the page, including a super-admin',
  description: 'App.esc built its output with textContent → innerHTML, which escapes & < > but not quotes, and 42 places put its output inside double-quoted attributes (title, data-name, value) with names an org admin types — a location named `x" onmouseover="…` gained a live handler. Fifteen inline onclick handlers passed names as esc(name).replace(/\'/g, "\\\\\'"), which a backslash or a double quote defeats. The CSP allows inline handlers, and a super-admin who enters the org opens these pages with a token for every tenant. Found by the 2026-10 product and architecture review (PAR-10/29).',
  module: 'ele',
  category: 'data-exposure',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/29)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'App.esc did not escape " and \'; inline handlers HTML-escaped (not JS-escaped) their string arguments.',
  expectedBehavior: 'App.esc escapes & < > " \'; inline handlers take App.escJs(text), which escapes for JS and then for HTML, so the exact text arrives as one argument.',
  brokenBehavior: 'A location named `x" data-x="1` rendered an extra attribute on admin-locations; an electrician named `x\\\');alert(1);//` ran code when Locations was clicked.',
  reproductionSteps: [
    'As an org admin, create a location named `Q" data-bug0028="1` and an electrician named `E\\\');window.__bug0028=1;//`.',
    'Open admin-locations, then admin-workers and click the electrician\'s Locations button.',
    'Broken: an element carries data-bug0028 and window.__bug0028 is 1. Fixed: neither. Browser test: e2e/tests/forms.spec.js (BUG-0028).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/public-escaping.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const App = loadApp();
    const attr = App.esc('x" onmouseover="alert(1) \'');
    if (/["']/.test(attr)) return { ok: false, detail: `App.esc leaves quotes: ${attr}` };
    if (typeof App.escJs !== 'function') return { ok: false, detail: 'App.escJs is missing' };
    const arg = "x\\');alert(1);//";
    const decoded = `f('${App.escJs(arg)}')`.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const calls = [];
    let injected = false;
    vm.runInNewContext(decoded, { f: (a) => calls.push(a), alert: () => { injected = true; } });
    if (injected || calls.length !== 1 || calls[0] !== arg) return { ok: false, detail: 'App.escJs lets a handler argument break out' };
    return { ok: true, detail: 'App.esc escapes quotes; App.escJs keeps handler arguments intact' };
  }
};
