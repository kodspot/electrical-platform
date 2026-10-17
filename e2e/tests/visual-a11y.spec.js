'use strict';

// C7 / QA-2 — design and accessibility checks for EVERY page, in both projects (desktop + Pixel 7).
// The page list is the explorer's (support/explorer.js: the app's route table), so a new page
// gets a screenshot check automatically. Each page gets a screenshot comparison
// (support/visual.js: "no baseline" until Linux baselines exist; never fails for a missing one)
// and an axe scan (fails only on critical; F16 pages are reported, see below).
//
// The pages show a dedicated "visual" org whose names, codes, dates and tickets are fixed, so
// the screenshots do not depend on the per-run seed or on what the journeys created. Every e2e
// run starts from a fresh database, so fixed slugs and codes are safe; within a run the org is
// created once and reused by the second project.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { db, seed, signIn, signInElectrician } = require('../support/app');
const { checkVisual, checkA11y } = require('../support/visual');
const { pages, allowlist } = require('../support/explorer');

const factories = () => require(path.join(__dirname, '..', '..', 'apps', 'api', 'scenarios', 'factories'));
const VISUAL_FILE = path.join(__dirname, '..', '.auth', 'visual.json');
const SLUG = 'e2e-visual';
const QR = 'VISUAL01';
const REVIEW_TOKEN = 'a1'.repeat(32);
// Every fixture row is dated, and every page's clock is frozen, at this instant.
const FROZEN_NOW = new Date('2026-01-15T10:00:00+05:30');
const at = (hoursBefore) => new Date(FROZEN_NOW.getTime() - hoursBefore * 3_600_000);

/** Create the visual org once per database; credentials live in .auth/visual.json (git-ignored). */
async function visualFixture() {
  if (fs.existsSync(VISUAL_FILE)) {
    const v = JSON.parse(fs.readFileSync(VISUAL_FILE, 'utf8'));
    if (await db().organization.findUnique({ where: { slug: SLUG } })) return v;
  }
  const f = factories();
  const pw = () => `Vis-${crypto.randomBytes(9).toString('base64url')}`;
  const org = await f.createTestOrg({ name: 'Visual Test Org', slug: SLUG, enabledModules: ['ele', 'asset'], createdAt: at(24 * 30) });
  const adminPw = pw();
  const admin = await f.createTestUser(org.id, { role: 'ADMIN', name: 'Visual Admin', email: 'visual-admin@example.test', password: adminPw, createdAt: at(24 * 30) });
  const supPw = pw();
  const sup = await f.createTestUser(org.id, { role: 'SUPERVISOR', name: 'Visual Supervisor', email: 'visual-sup@example.test', password: supPw, createdAt: at(24 * 30) });
  const building = await f.createTestLocation(org.id, { name: 'Main Block', type: 'BUILDING', qrCode: 'VISUALB1', createdAt: at(24 * 30) });
  const room = await f.createTestLocation(org.id, { name: 'Room 101', type: 'ROOM', parentId: building.id, qrCode: QR, createdAt: at(24 * 30) });
  await f.createTestSupervisorAssignment(org.id, sup.id, building.id, { coverChildren: true });
  const pin = String(crypto.randomInt(100000, 999999));
  const worker = await f.createTestWorker(org.id, { pin, name: 'Visual Electrician', employeeId: 'VISUAL-E1', createdAt: at(24 * 30) });
  await f.createTestWorkerAssignment(org.id, worker.id, building.id, { coverChildren: true });
  await f.createTestTicket(org.id, room.id, { title: 'Light not working', description: 'Tube light flickering', createdAt: at(3) });
  await f.createTestTicket(org.id, room.id, { title: 'Fan making noise', priority: 'HIGH', status: 'IN_PROGRESS', createdAt: at(2) });
  await f.createTestTicket(org.id, room.id, {
    title: 'Socket sparking', status: 'RESOLVED', source: 'PUBLIC', createdAt: at(30), resolvedAt: at(5), resolvedNote: 'Socket replaced',
    reviewToken: REVIEW_TOKEN, reviewStatus: 'PENDING', reviewExpiresAt: new Date('2099-01-01T00:00:00Z')
  });
  const asset = await f.createTestAsset(org.id, room.id, { name: 'Main Panel', assetCode: 'VIS-A1', createdAt: at(24 * 20) });
  await f.createTestAssetFailure(org.id, asset.id, admin.id, { title: 'Breaker tripping', failedAt: at(6), createdAt: at(6) });
  await db().inspectionTemplate.create({
    data: { orgId: org.id, name: 'Standard Room Check', isDefault: true, createdAt: at(24 * 30), items: { create: [{ label: 'Lighting', checkKey: 'LIGHTING', sortOrder: 0 }, { label: 'MCB Panel', checkKey: 'MCB_PANEL', sortOrder: 1 }] } }
  });
  const v = {
    org: { id: org.id, slug: SLUG },
    fx: { slug: SLUG, qrCode: QR, locationId: room.id, reviewToken: REVIEW_TOKEN },
    admin: { email: admin.email, password: adminPw },
    supervisor: { email: sup.email, password: supPw },
    worker: { employeeId: worker.employeeId, pin }
  };
  fs.mkdirSync(path.dirname(VISUAL_FILE), { recursive: true });
  fs.writeFileSync(VISUAL_FILE, JSON.stringify(v));
  return v;
}

// Pages whose content depends on a live external feed get a fixed input, not a mask: the
// Quality page's Live CI list comes from GitHub (/api/superadmin/qa/ci-status), so that request
// is answered with a fixed response and the panel renders real, stable content.
const CI_STATUS_STUB = {
  state: 'ok',
  cached: false,
  dispatchEnabled: false,
  fetchedAt: '2026-01-15T04:30:00.000Z',
  runs: [
    { id: 3, name: 'Deploy to Production', branch: 'main', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-01-15T04:00:00Z', updated_at: '2026-01-15T04:05:00Z', html_url: 'https://github.com/kodspot/electrical-platform/actions/runs/3', head_sha: 'aaaaaaa1111111' },
    { id: 2, name: 'E2E', branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-01-14T21:30:00Z', updated_at: '2026-01-14T21:33:00Z', html_url: 'https://github.com/kodspot/electrical-platform/actions/runs/2', head_sha: 'bbbbbbb2222222' },
    { id: 1, name: 'Deploy to Production', branch: 'fix-branch', event: 'pull_request', status: 'completed', conclusion: 'failure', created_at: '2026-01-14T10:00:00Z', updated_at: '2026-01-14T10:04:00Z', html_url: 'https://github.com/kodspot/electrical-platform/actions/runs/1', head_sha: 'ccccccc3333333' }
  ]
};

// The super-admin dashboard lists every organization on the platform, i.e. every e2e org of the
// run (per-run names that wrap differently on a phone): its list is answered with two fixed orgs.
const ORGS_STUB = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Visual Test Org', slug: 'e2e-visual', type: 'HOSPITAL', status: 'ACTIVE', enabledModules: ['ele', 'asset'], phone: '98765 43210', aiEnabled: false, _count: { users: 2, workers: 1 } },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Second Campus', slug: 'second-campus', type: 'COLLEGE', status: 'SUSPENDED', enabledModules: ['ele'], phone: null, aiEnabled: false, _count: { users: 1, workers: 0 } }
];
const isOrgList = (url) => new URL(url).pathname === '/api/superadmin/organizations';

// Regions that differ by run however the data is fixed: charts, and on the super-admin pages the
// platform-wide numbers and the signed-in name and initials (the seed's super-admin is per run).
// admin-predictions: its 12-week trend is labelled with weeks counted from the SERVER's date,
// which the frozen page clock cannot fix.
const MASKS = {
  'admin-dashboard': ['svg'],
  'admin-analytics': ['svg'],
  'admin-predictions': ['.trend-bars'],
  'superadmin-dashboard': ['#userName', '.user-avatar', '.user-menu-name', '#statsGrid', '#metricsGrid', '#orgBreakdown', '#trendChart'],
  'superadmin-quality': ['#userName', '.user-avatar', '.user-menu-name', '#trendChart']
};

// The names of baseline files: the explorer's page names, made file-safe.
const fileName = (name) => `${name.replace(/[^\w-]+/g, '-').replace(/-+$/, '')}.png`;
const NAMES = pages({ slug: SLUG, qrCode: QR, locationId: 'LOC', reviewToken: REVIEW_TOKEN });

test.describe('C7 — design and accessibility, every page', () => {
  let v;
  test.beforeAll(async () => { v = await visualFixture(); });

  for (const { name, role } of NAMES) {
    test(`${name}: screenshot matches the baseline (or "no baseline"), and axe finds no critical violation`, async ({ page }, testInfo) => {
      const entry = pages(v.fx).find((p) => p.name === name);
      await page.clock.setFixedTime(FROZEN_NOW);
      if (role === 'admin') await signIn(page, 'admin', v.admin, SLUG);
      else if (role === 'supervisor') await signIn(page, 'supervisor', v.supervisor, SLUG);
      else if (role === 'electrician') await signInElectrician(page, v.worker, SLUG);
      else if (role === 'superadmin') {
        await page.route('**/api/superadmin/qa/ci-status', (route) => route.fulfill({ json: CI_STATUS_STUB }));
        await page.route(isOrgList, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: ORGS_STUB }) : route.continue()));
        await signIn(page, 'superadmin', seed().superAdmin);
      }
      const resp = await page.goto(entry.url);
      expect(resp && resp.status(), `${entry.url} status`).toBe(200);
      await expect(page.locator('body')).toBeVisible();
      await expect(page.getByText('Organization not found')).toHaveCount(0);
      await checkVisual(page, testInfo, fileName(name), MASKS[name] || []);
      // Known critical findings come from the explorer's shrink-only allow-list (F16).
      const known = allowlist().find((e) => e.check === 'axe' && (e.role === '*' || e.role === role) && e.page === name);
      await checkA11y(page, testInfo, name, { knownCritical: known && known.finding });
    });
  }
});
