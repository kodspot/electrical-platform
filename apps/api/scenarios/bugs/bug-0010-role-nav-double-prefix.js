'use strict';

/**
 * BUG-0010 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { loadApp: load, visibleHrefs } = require('./support/app-vm');

const SLUG = 'bug0010-org';
const loadApp = (pageName, navLinks) => load(pageName, navLinks, { slug: SLUG, enabledModules: ['ele'] });

module.exports = {
  id: 'BUG-0010',
  title: 'Electrician and supervisor nav links were double-prefixed (/{org}/{mod}/{org}/{mod}/{page} → 404)',
  description: 'public/js/app.js rewrote the role nav links twice: _applyRoleNavScope ran when the page initialised (initElectrician/initSupervisor) and again after /auth/worker-me (/auth/me) returned (_syncEnabledModulesFor*). The second pass read the already-rewritten href and prefixed it again, so Tickets, My Work and Scan pointed at e.g. /jnmc/ele/jnmc/ele/electrician-tickets and answered 404.',
  module: 'ele',
  category: 'navigation',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Production report (GET /jnmc/ele/jnmc/ele/electrician-tickets 404), fixed 2026-10-16',
  dateIntroduced: '2026-07-24 (530bbd5)',
  dateFixed: '2026-10-16',
  rootCause: '_applyRoleNavScope derived the page from getAttribute("href") on every call, which after the first call is already /{org}/{mod}/{page}; stripping only the leading "/" and calling orgPath() again doubled the prefix. E2E never clicked the nav (it navigates with page.goto), so it never saw the result.',
  expectedBehavior: 'However many times the nav is rewritten, every link is /{org}/{mod}/{page}; links for disabled modules (data-mod) stay hidden.',
  brokenBehavior: 'After the module sync, links were /{org}/{mod}/{org}/{mod}/{page} and navigating answered 404.',
  reproductionSteps: [
    'Sign in as an electrician (or supervisor) and open electrician-scan (supervisor-scan).',
    'Wait for /api/auth/worker-me (/api/auth/me) to complete, then click Tickets.',
    'Broken: 404 at /{org}/ele/{org}/ele/electrician-tickets. Fixed: 200 at /{org}/ele/electrician-tickets.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js; e2e/tests/journeys.spec.js › "electrician nav links work after module sync (BUG-0010)" and "supervisor nav links work after module sync (BUG-0010)"',

  async apply() {
    return {};
  },

  async validate() {
    // Electrician: init (sync pass) + worker-me sync (async pass) + one more init.
    const elec = loadApp('electrician-scan', [{ href: '/electrician-scan' }, { href: '/electrician-tickets' }, { href: '/electrician-my-work' }]);
    elec.App.initElectrician();
    await elec.settle();
    elec.App.initElectrician();
    await elec.settle();
    const wantElec = ['electrician-scan', 'electrician-tickets', 'electrician-my-work'].map((p) => `/${SLUG}/ele/${p}`);
    if (JSON.stringify(visibleHrefs(elec.links)) !== JSON.stringify(wantElec)) {
      return { ok: false, detail: `electrician nav hrefs: ${visibleHrefs(elec.links).join(', ')}` };
    }

    // Supervisor, including a link for a module the org has not enabled (asset).
    const sup = loadApp('supervisor-assets', [{ href: '/supervisor-scan' }, { href: '/supervisor-assets', 'data-mod': 'asset' }, { href: '/supervisor-tickets' }]);
    sup.App.initSupervisor();
    await sup.settle();
    sup.App.initSupervisor();
    await sup.settle();
    const wantSup = ['supervisor-scan', 'supervisor-tickets'].map((p) => `/${SLUG}/ele/${p}`);
    if (JSON.stringify(visibleHrefs(sup.links)) !== JSON.stringify(wantSup)) {
      return { ok: false, detail: `supervisor nav hrefs: ${visibleHrefs(sup.links).join(', ')}` };
    }
    if (sup.links[1].style.display !== 'none') return { ok: false, detail: 'the disabled-module (asset) link is visible' };
    return { ok: true, detail: 'after init + module sync + re-init, every role nav link is /{org}/ele/{page}; the disabled-module link stays hidden' };
  }
};
