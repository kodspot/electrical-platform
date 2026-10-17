'use strict';

/**
 * BUG-0011 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const { loadApp, visibleHrefs } = require('./support/app-vm');

const SLUG = 'bug0011-org';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

module.exports = {
  id: 'BUG-0011',
  title: 'A role nav link hidden until the module sync came back double-prefixed (supervisor Assets → 404)',
  description: 'BUG-0010 made _applyRoleNavScope remember each link\'s page in data-page, but only for links it showed. A link for a module the browser did not yet know was enabled (no localStorage.enabledModules, e.g. a fresh sign-in) was hidden on the first pass without remembering its page; when /auth/me then reported the module, the second pass read the already-rewritten href and prefixed it again. supervisor-assets.html and supervisor-electrical.html also rewrote every #sv-nav href themselves after initSupervisor(), doubling all of them until the sync repaired the visible ones. Found by the e2e explorer: the Assets link on supervisor-assets pointed at /{org}/ele/{org}/ele/supervisor-assets (404).',
  module: 'ele',
  category: 'navigation',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'e2e explorer (QA-2), first run; fixed 2026-10-17',
  dateIntroduced: '2026-07-24 (530bbd5); incompletely fixed by BUG-0010 (2026-10-16)',
  dateFixed: '2026-10-17',
  rootCause: '_applyRoleNavScope skipped the data-page capture for links it hid, so a hidden-then-shown link fell back to re-reading its href; and two supervisor pages repeated the nav rewrite inline from getAttribute("href").',
  expectedBehavior: 'Every role nav link is /{org}/{mod}/{page} after init and after the module sync, whether or not it was hidden at first; no page rewrites #sv-nav hrefs itself.',
  brokenBehavior: 'On supervisor-assets the Assets link became /{org}/ele/{org}/ele/supervisor-assets (404); on supervisor-assets and supervisor-electrical every nav link was double-prefixed until /auth/me answered.',
  reproductionSteps: [
    'Org with the assets module on. Sign in as a supervisor in a browser with no localStorage.enabledModules.',
    'Open /{org}/ele/supervisor-assets and wait for /api/auth/me.',
    'Broken: the Assets link is /{org}/ele/{org}/ele/supervisor-assets. Fixed: /{org}/ele/supervisor-assets.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › "supervisor › supervisor-assets" and "supervisor › supervisor-electrical"',

  async apply() {
    return {};
  },

  async validate() {
    // The browser does not know yet that the org has assets (nothing stored): the first pass
    // hides the Assets link; the sync shows it.
    // In between, replay what supervisor-assets.html did right after initSupervisor(): rewrite
    // every #sv-nav href from its current value. The sync must still end with correct links.
    const sup = loadApp('supervisor-assets', [{ href: '/supervisor-scan' }, { href: '/supervisor-assets', 'data-mod': 'asset' }, { href: '/supervisor-tickets' }], { slug: SLUG, enabledModules: ['ele', 'asset'] });
    sup.App.initSupervisor();
    for (const a of sup.links) a.href = sup.App.orgPath(a.getAttribute('href').replace(/^\//, ''));
    await sup.settle();
    const want = ['supervisor-scan', 'supervisor-assets', 'supervisor-tickets'].map((p) => `/${SLUG}/ele/${p}`);
    if (JSON.stringify(visibleHrefs(sup.links)) !== JSON.stringify(want)) {
      return { ok: false, detail: `supervisor nav hrefs after the sync: ${visibleHrefs(sup.links).join(', ')}` };
    }
    // No page repeats the nav rewrite from the (already rewritten) href.
    const rewriting = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'))
      .filter((f) => /#sv-nav a[^\n]*getAttribute\('href'\)/.test(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')));
    if (rewriting.length) return { ok: false, detail: `pages rewrite #sv-nav hrefs themselves: ${rewriting.join(', ')}` };
    return { ok: true, detail: 'a link hidden until the module sync is /{org}/ele/{page} once shown; no page rewrites #sv-nav hrefs itself' };
  }
};
