'use strict';

// C7 — design and accessibility checks, in both projects (desktop + Pixel 7).
// Each page gets a screenshot comparison (support/visual.js: "no baseline" until Linux
// baselines exist; never fails for a missing one) and an axe scan (fails only on critical).
//
// The pages show a dedicated "visual" org whose names, codes and tickets are fixed, so the
// screenshots do not depend on the per-run seed or on what the journeys created. Every e2e
// run starts from a fresh database, so fixed slugs and codes are safe; within a run the
// org is created once and reused by the second project.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { db, signIn, orgPage } = require('../support/app');
const { checkVisual, checkA11y } = require('../support/visual');

const factories = () => require(path.join(__dirname, '..', '..', 'apps', 'api', 'scenarios', 'factories'));
const VISUAL_FILE = path.join(__dirname, '..', '.auth', 'visual.json');
const SLUG = 'e2e-visual';
const QR = 'VISUAL01';

/** Create the visual org once per database; credentials live in .auth/visual.json (git-ignored). */
async function visualFixture() {
  if (fs.existsSync(VISUAL_FILE)) {
    const v = JSON.parse(fs.readFileSync(VISUAL_FILE, 'utf8'));
    if (await db().organization.findUnique({ where: { slug: SLUG } })) return v;
  }
  const f = factories();
  const pw = () => `Vis-${crypto.randomBytes(9).toString('base64url')}`;
  const org = await f.createTestOrg({ name: 'Visual Test Org', slug: SLUG });
  const adminPw = pw();
  const admin = await f.createTestUser(org.id, { role: 'ADMIN', name: 'Visual Admin', email: 'visual-admin@example.test', password: adminPw });
  const saPw = pw();
  const sa = await f.createTestUser(null, { role: 'SUPER_ADMIN', name: 'Visual Super Admin', email: 'visual-sa@example.test', password: saPw });
  const building = await f.createTestLocation(org.id, { name: 'Main Block', type: 'BUILDING', qrCode: 'VISUALB1' });
  const room = await f.createTestLocation(org.id, { name: 'Room 101', type: 'ROOM', parentId: building.id, qrCode: QR });
  const pin = String(crypto.randomInt(100000, 999999));
  const worker = await f.createTestWorker(org.id, { pin, name: 'Visual Electrician', employeeId: 'VISUAL-E1' });
  await f.createTestWorkerAssignment(org.id, worker.id, building.id, { coverChildren: true });
  await f.createTestTicket(org.id, room.id, { title: 'Light not working', description: 'Tube light flickering' });
  await f.createTestTicket(org.id, room.id, { title: 'Fan making noise', priority: 'HIGH', status: 'IN_PROGRESS' });
  const v = {
    org: { id: org.id, slug: SLUG },
    admin: { email: admin.email, password: adminPw },
    superAdmin: { email: sa.email, password: saPw },
    worker: { employeeId: worker.employeeId, pin }
  };
  fs.mkdirSync(path.dirname(VISUAL_FILE), { recursive: true });
  fs.writeFileSync(VISUAL_FILE, JSON.stringify(v));
  return v;
}

async function signInElectrician(page, v) {
  const res = await page.request.post('/api/auth/worker-login', { data: { orgSlug: SLUG, employeeId: v.worker.employeeId, pin: v.worker.pin } });
  expect(res.status()).toBe(200);
  const { token, worker } = await res.json();
  await page.addInitScript(({ token, worker, slug }) => {
    localStorage.setItem('elec_token', token);
    localStorage.setItem('elec_user', JSON.stringify(worker || {}));
    localStorage.setItem('orgSlug', slug);
    localStorage.setItem('activeModule', 'ele');
  }, { token, worker, slug: SLUG });
}

// [name, how to get there, page-specific dynamic regions to mask]
const PAGES = [
  ['admin-login', async (page) => page.goto(orgPage(SLUG, 'admin-login')), []],
  ['supervisor-login', async (page) => page.goto(orgPage(SLUG, 'supervisor-login')), []],
  ['electrician-login', async (page) => page.goto(orgPage(SLUG, 'electrician-login')), []],
  ['admin-dashboard', async (page, v) => { await signIn(page, 'admin', v.admin, SLUG); await page.goto(orgPage(SLUG, 'admin-dashboard')); }, ['svg']],
  ['admin-tickets', async (page, v) => { await signIn(page, 'admin', v.admin, SLUG); await page.goto(orgPage(SLUG, 'admin-tickets')); }, []],
  ['admin-locations', async (page, v) => { await signIn(page, 'admin', v.admin, SLUG); await page.goto(orgPage(SLUG, 'admin-locations')); }, []],
  ['admin-qr-print', async (page, v) => { await signIn(page, 'admin', v.admin, SLUG); await page.goto(orgPage(SLUG, 'admin-qr-print')); }, []],
  ['guest-complaint', async (page) => page.goto(`/s/${QR}`), []],
  ['electrician-my-work', async (page, v) => { await signInElectrician(page, v); await page.goto(orgPage(SLUG, 'electrician-my-work')); }, []],
  ['superadmin-quality', async (page, v) => { await signIn(page, 'superadmin', v.superAdmin); await page.goto('/superadmin-quality'); }, ['#ciList', '#ciUpdated', '#trendChart']]
];

test.describe('C7 — design and accessibility', () => {
  let v;
  test.beforeAll(async () => { v = await visualFixture(); });

  for (const [name, open, masks] of PAGES) {
    test(`${name}: screenshot matches the baseline (or "no baseline"), and axe finds no critical violation`, async ({ page }, testInfo) => {
      await open(page, v);
      await expect(page.locator('body')).toBeVisible();
      await expect(page.getByText('Organization not found')).toHaveCount(0);
      await checkVisual(page, testInfo, `${name}.png`, masks);
      await checkA11y(page, testInfo, name);
    });
  }
});
