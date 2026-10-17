'use strict';

/**
 * BUG-0013 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** What a signed-in admin page needs so App.initAdmin can build its nav (desktop and phone). */
function shellProblems(html) {
  const problems = [];
  if (!/<div\s+(class="topbar-nav"\s+id="topbar-nav"|id="topbar-nav"\s+class="topbar-nav")\s*>/.test(html)) problems.push('no <div class="topbar-nav" id="topbar-nav">');
  if (!/id="nav-toggle"/.test(html)) problems.push('no #nav-toggle menu button');
  // .main-content and .sidebar are defined nowhere: a bare <main class="main-content"> gets no layout
  // (admin-attendance styles its own inline, which is fine).
  if (/<main class="main-content">|<nav class="sidebar"/.test(html)) problems.push('uses an undefined layout class (main-content / sidebar) with no layout of its own');
  return problems;
}

module.exports = {
  id: 'BUG-0013',
  title: 'Four admin pages had no working admin nav (assets, electrical, failures: run-together links and a too-wide page on phones; predictions: none at all)',
  description: 'admin-assets, admin-electrical and admin-failures rendered #topbar-nav without the topbar-nav class (an unstyled row of touching links, about 1030 px wide on a phone — F17) and used <main class="main-content">, a class defined nowhere. admin-predictions had a <nav class="sidebar"> and no topbar, so no navigation. admin-alerts had no #nav-toggle, so its nav could not be opened on a phone. Found by the QA-2 visual baselines.',
  module: 'ele',
  category: 'ui',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'QA-2 visual baselines and the explorer (F17), 2026-10-17; fixed 2026-10-18',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-18',
  rootCause: 'These pages were built outside the shared admin page shell (topbar markup + container) that the other admin pages and App.initAdmin rely on.',
  expectedBehavior: 'Every admin page has the shared shell: <div class="topbar-nav" id="topbar-nav">, the #nav-toggle menu button, and the shared layout classes.',
  brokenBehavior: 'Nav links ran together and the page overflowed on a phone (assets, electrical, failures); no nav at all (predictions); no phone menu (alerts).',
  reproductionSteps: [
    'Sign in as an admin and open /{org}/ele/admin-assets (or electrical, failures, predictions, alerts).',
    'Broken: the nav links touch / are missing, and on a phone the page scrolls sideways. Fixed: the same nav as admin-tickets.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › nav and overflow checks (admin pages)',

  async apply() {
    return {};
  },

  async validate() {
    const pages = fs.readdirSync(PUBLIC_DIR).filter((f) => /^admin-.+\.html$/.test(f) && f !== 'admin-login.html');
    const bad = [];
    for (const f of pages) {
      const p = shellProblems(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'));
      if (p.length) bad.push(`${f}: ${p.join('; ')}`);
    }
    if (bad.length) return { ok: false, detail: bad.join(' | ') };
    return { ok: true, detail: `all ${pages.length} admin pages have the shared admin shell` };
  }
};
