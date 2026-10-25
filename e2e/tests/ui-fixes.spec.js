'use strict';

// UI defects found by the QA-2 visual baselines that need a browser to check. The others are
// covered by the explorer (rawValue, nav, overflow, axe) and the bug registry (BUG-0012..0014).

const { test, expect } = require('@playwright/test');
const path = require('node:path');
const crypto = require('node:crypto');
const { seed, db, apiLogin, signIn, orgPage, photo } = require('../support/app');

// F18: on the module home, "← All modules" (shown when an org has more than one module) used
// var(--primary) — blue on the blue page gradient. axe cannot measure contrast over a
// gradient (it reports "needs review", not a violation), so this computes the WCAG ratio
// between the link's colour and EVERY colour stop of the gradient behind it, and requires AA.
test('F18 — the module home\'s "All modules" link has readable contrast (WCAG AA) on every part of the gradient', async ({ page }) => {
  const s = seed();
  await page.goto(`/${s.explorer.org.slug}/ele`);
  const link = page.locator('.mod-back a');
  await expect(link).toBeVisible();
  const { text, stops } = await link.evaluate((a) => {
    const rgb = (s) => (s.match(/rgba?\([^)]*\)/g) || []).map((c) => c.match(/[\d.]+/g).slice(0, 3).map(Number));
    // The nearest ancestor that paints a background (an image/gradient or an opaque colour).
    let el = a.parentElement;
    let stops = [];
    while (el && !stops.length) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') stops = rgb(cs.backgroundImage);
      else if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) stops = rgb(cs.backgroundColor);
      el = el.parentElement;
    }
    return { text: rgb(getComputedStyle(a).color)[0], stops };
  });
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  expect(stops.length, 'no background found behind the link').toBeGreaterThan(0);
  const worst = Math.min(...stops.map((st) => ratio(text, st)));
  expect(worst, `lowest contrast of the link against the gradient (text rgb(${text}))`).toBeGreaterThanOrEqual(4.5);
});

// BUG-0039 (and PAR-10/27): two pages read a field the API never sends. Analytics' electrician
// and supervisor bars read `records` (the API sends `inspections`), so every bar was labelled
// "undefined" with a NaN width; the dashboard's "Today's Inspection Log" read `inspections`
// (GET /electrical-inspections sends `records`), so it always said "No inspections logged
// today". Shown only when inspections exist — the explorer org has none until other tests add
// some, which is why the explorer flagged it only in full runs. These tests use the explorer
// org and its admin (one cached sign-in per run: login is limited per IP) and remove what they
// add.
const factories = () => require(path.join(__dirname, '..', '..', 'apps', 'api', 'scenarios', 'factories'));

test("BUG-0039 — analytics bars show inspection counts, and the dashboard lists today's inspection", async ({ page }) => {
  const f = factories();
  const x = seed().explorer;
  const location = await f.createTestLocation(x.org.id);
  const worker = await f.createTestWorker(x.org.id);
  const inspection = await f.createTestElectricalInspection(x.org.id, location.id, x.supervisor.id, { inspectedAt: new Date(), workers: { connect: [{ id: worker.id }] } });
  try {
    await signIn(page, 'admin', x.admin, x.org.slug);
    await page.goto(orgPage(x.org.slug, 'admin-analytics'));
    for (const section of ['#workerPerf', '#supPerf']) {
      const labels = page.locator(`${section} .an-perf-lbl`);
      await expect(labels.first()).toBeVisible();
      for (const text of await labels.allTextContents()) expect(text, `${section} bar label`).toMatch(/^\d+$/);
    }
    await page.goto(orgPage(x.org.slug, 'admin-dashboard'));
    await expect(page.locator('#photoBadge')).toHaveText(/^[1-9]\d* inspections?$/);
    await expect(page.locator('#photoGallery')).toContainText(location.name);
  } finally {
    await db().electricalInspection.deleteMany({ where: { id: inspection.id } });
    await db().worker.deleteMany({ where: { id: worker.id } });
    await db().location.deleteMany({ where: { id: location.id } });
  }
});

// BUG-0040 (PAR-10/24): the asset, failure and inspection detail views on the admin pages
// rendered stored photos by their raw /images/... path. Images are served only through
// /api/images/... with the viewer's token (App.imgUrl), so every one of those photos was a
// broken image. The fixtures carried no such photos, so nothing noticed.
test('BUG-0040 — asset, failure and inspection photos load in the admin detail views', async ({ page }) => {
  const f = factories();
  const x = seed().explorer;
  const tag = `P40 ${crypto.randomUUID().slice(0, 8)}`;
  const location = await f.createTestLocation(x.org.id, { name: `${tag} room` });
  const ticket = await f.createTestTicket(x.org.id, location.id, { status: 'IN_PROGRESS' });
  const created = {};
  try {
    // One real stored photo, uploaded the way the app stores any photo: resolving a ticket.
    const { token } = await apiLogin(page.request, x.admin);
    const resolved = await page.request.post(`/api/tickets/${ticket.id}/resolve`, { headers: { authorization: `Bearer ${token}` }, multipart: { note: 'Fixed', image: photo() } });
    expect(resolved.ok(), await resolved.text()).toBeTruthy();
    const url = (await resolved.json()).resolvedImageUrl;

    created.asset = await f.createTestAsset(x.org.id, location.id, { name: `${tag} panel` });
    await db().assetImage.create({ data: { assetId: created.asset.id, imageUrl: url } });
    created.failure = await f.createTestAssetFailure(x.org.id, created.asset.id, x.admin.id, { title: `${tag} breaker trips` });
    await db().assetFailureImage.create({ data: { failureId: created.failure.id, imageUrl: url } });
    created.inspection = await f.createTestElectricalInspection(x.org.id, location.id, x.supervisor.id, { inspectedAt: new Date() });
    await db().electricalImage.create({ data: { inspectionId: created.inspection.id, imageUrl: url } });

    await signIn(page, 'admin', x.admin, x.org.slug);
    for (const [pageName, rowText] of [['admin-assets', `${tag} panel`], ['admin-failures', `${tag} breaker trips`], ['admin-electrical', `${tag} room`]]) {
      await page.goto(orgPage(x.org.slug, pageName));
      await page.locator('tr', { hasText: rowText }).getByRole('button', { name: 'View' }).click();
      const img = page.locator('#detailContent img').first();
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { message: `${pageName}: the photo loads` }).toBe(true);
    }
  } finally {
    if (created.inspection) await db().electricalInspection.deleteMany({ where: { id: created.inspection.id } });
    if (created.asset) await db().asset.deleteMany({ where: { id: created.asset.id } });
    await db().ticket.deleteMany({ where: { id: ticket.id } });
    await db().location.deleteMany({ where: { id: location.id } });
  }
});
