'use strict';

/**
 * BUG-0040 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PAGES = ['admin-assets.html', 'admin-failures.html', 'admin-electrical.html'];

module.exports = {
  id: 'BUG-0040',
  title: 'Asset, failure and inspection photos were broken images in the admin detail views',
  description: 'admin-assets, admin-failures and admin-electrical rendered stored photos by their raw /images/... path. Images are served only through /api/images/... with the viewer\'s token (App.imgUrl, F15), so every such photo failed to load — the admin could not see the evidence attached to an asset, a failure report or an inspection. The visual and explorer fixtures carried no photos, so nothing noticed. Found by the 2026-10 product and architecture review (PAR-10/24).',
  module: 'asset',
  category: 'ui',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/24)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'Those three detail views built <img src> from img.imageUrl directly instead of App.imgUrl(img.imageUrl).',
  expectedBehavior: 'Every stored photo in the three detail views is requested through App.imgUrl, and loads.',
  brokenBehavior: 'The images loaded /images/uploads/... and got 404.',
  reproductionSteps: [
    'Attach a stored photo to an asset (or a failure, or an inspection).',
    'Open admin-assets (admin-failures, admin-electrical) and press View on that row.',
    'Broken: a broken image. Fixed: the photo shows. Browser test: e2e/tests/ui-fixes.spec.js (BUG-0040).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/ui-fixes.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    for (const page of PAGES) {
      const lines = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8').split(/\r?\n/);
      const raw = lines.filter((l) => /<img src=/.test(l) && /imageUrl/.test(l) && !/imgUrl\(/.test(l));
      if (raw.length) return { ok: false, detail: `${page} renders a stored photo without App.imgUrl` };
      if (!lines.some((l) => /imgUrl\(img\.imageUrl\)/.test(l))) return { ok: false, detail: `${page} no longer renders the detail photos through App.imgUrl` };
    }
    return { ok: true, detail: 'all three detail views load photos through App.imgUrl' };
  }
};
