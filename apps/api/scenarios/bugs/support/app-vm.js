'use strict';

/**
 * Load the real public/js/app.js in a Node vm with a minimal DOM, for bug scenarios about
 * the role nav (BUG-0010, BUG-0011): one #sv-nav, a stubbed fetch that answers
 * /auth/worker-me and /auth/me with the given enabled modules, localStorage, no service
 * worker. Not a bug module itself — the registry lists only bug-*.js files.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', '..', '..', 'public', 'js', 'app.js');

// A link as a browser models it: assigning `href` stores exactly the assigned string as the
// attribute (what getAttribute('href') returns next time).
function fakeLink(attrs) {
  const a = { attrs: { ...attrs }, style: { display: '' } };
  a.getAttribute = (n) => (Object.prototype.hasOwnProperty.call(a.attrs, n) ? a.attrs[n] : null);
  a.setAttribute = (n, v) => { a.attrs[n] = String(v); };
  Object.defineProperty(a, 'href', { get: () => a.attrs.href, set: (v) => { a.attrs.href = String(v); } });
  return a;
}

/**
 * @param {string} pageName — the page the vm pretends to be on (/{slug}/ele/{pageName})
 * @param {object[]} navLinks — attributes of the #sv-nav links
 * @param {{ slug: string, enabledModules?: string[], stored?: string[] }} opts — what the
 *   sync answers, and what localStorage.enabledModules holds before it (absent by default)
 * @returns {{ App: object, links: object[], settle: () => Promise<void> }}
 */
function loadApp(pageName, navLinks, { slug, enabledModules = ['ele'], stored } = {}) {
  const store = new Map([
    ['elec_token', 't'], ['elec_user', '{}'], ['sup_token', 't'], ['sup_user', '{}'], ['orgSlug', slug]
  ]);
  if (stored) store.set('enabledModules', JSON.stringify(stored));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
  const links = navLinks.map(fakeLink);
  const nav = { querySelectorAll: () => links };
  const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const document = {
    getElementById: (id) => (id === 'sv-nav' ? nav : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: el,
    head: el(),
    body: el(),
    addEventListener() {}
  };
  let pending = 0;
  const me = { org: { slug, name: 'Bug Scenario Org', enabledModules } };
  const fetch = async () => {
    pending++;
    await new Promise((r) => setImmediate(r));
    pending--;
    return { ok: true, status: 200, json: async () => me };
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, FormData, AbortController, AbortSignal,
    document, localStorage, fetch,
    location: { pathname: `/${slug}/ele/${pageName}`, search: '', href: '' },
    navigator: {},
    addEventListener() {}
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), context, { filename: 'app.js' });
  const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (!pending) await new Promise((r) => setImmediate(r)); } };
  return { App: context.window.App, links, settle };
}

const visibleHrefs = (links) => links.filter((l) => l.style.display !== 'none').map((l) => l.attrs.href);

module.exports = { loadApp, fakeLink, visibleHrefs };
