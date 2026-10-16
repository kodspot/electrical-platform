'use strict';

// Browser journeys J1–J7. J1–J6 are one ordered story (each builds on the previous step's
// data), so they run serially and only in the desktop project; steps that happen on a phone
// open their own Pixel 7 context. Every journey asserts what the user sees AND the database
// or API state behind it. No fixed sleeps: only auto-waiting locators and expect.poll.

const path = require('node:path');
const { test, expect, devices } = require('@playwright/test');
const { seed, db, apiLogin, signIn, orgPage, pickOption, photo, decodeQrSvg } = require('../support/app');

const APP_URL = 'http://127.0.0.1:3100';
const factories = () => require(path.join(__dirname, '..', '..', 'apps', 'api', 'scenarios', 'factories'));
const mobile = () => ({ ...devices['Pixel 7'] });

test.describe.serial('Journeys J1–J6: QR → guest complaint → electrician → supervisor → internal ticket', () => {
  // Read lazily: spec files are loaded to list tests before global setup writes the seed.
  let s;
  const state = {};
  test.beforeAll(() => { s = seed(); });

  test.afterAll(async () => {
    if (state.elecContext) await state.elecContext.close();
  });

  test('J1 — admin creates a location, prints its QR, and the QR encodes APP_URL/s/<code>', async ({ page }) => {
    await signIn(page, 'admin', s.adminA, s.orgA.slug);
    await page.goto(orgPage(s.orgA.slug, 'admin-locations'));
    await page.getByRole('button', { name: '+ Add Location' }).click();
    const name = `E2E Room ${s.run}`;
    await page.locator('#locName').fill(name);
    await pickOption(page, 'locType', 'Room');
    // The parent list shows each location's full path.
    await pickOption(page, 'locParent', `${s.names.building} → ${s.names.floor} (FLOOR)`);
    await page.locator('#locForm button[type=submit]').click();

    await expect.poll(async () => {
      const loc = await db().location.findFirst({ where: { orgId: s.orgA.id, name } });
      return loc && loc.parentId;
    }).toBe(s.locations.floor);
    const loc = await db().location.findFirst({ where: { orgId: s.orgA.id, name } });
    expect(loc.type).toBe('ROOM');
    state.location = loc;

    await page.goto(orgPage(s.orgA.slug, 'admin-qr-print'));
    const item = page.locator('.qr-item', { hasText: `Code: ${loc.qrCode}` });
    await expect(item.locator('svg')).toBeVisible();
    const printedSvg = await item.locator('svg').first().evaluate((el) => el.outerHTML);

    // Download the SVG the print page renders, as an admin would.
    const { token } = await apiLogin(page.request, s.adminA);
    const download = await page.request.get(`/api/locations/${loc.id}/qr-image`, { headers: { authorization: `Bearer ${token}` } });
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toContain('image/svg+xml');
    const decoded = await decodeQrSvg(page, await download.text());
    expect(decoded).toBe(`${APP_URL}/s/${loc.qrCode}`);
    expect(await decodeQrSvg(page, printedSvg)).toBe(decoded);
    state.qrUrl = decoded;
  });

  test('J2 — a guest on a phone opens the QR link, reports a light fault with a photo', async ({ browser }) => {
    const ctx = await browser.newContext(mobile());
    const page = await ctx.newPage();
    const marker = `E2E complaint ${s.run}`;
    await page.goto(state.qrUrl);
    await page.locator('.issue-opt[data-issue="LIGHT_NOT_WORKING"]').click();
    await page.locator('#descField').fill(marker);
    await page.locator('#photoInput').setInputFiles(photo('fault.png'));
    await expect(page.locator('#photoPreview')).toBeVisible();
    await page.locator('#nameField').fill('E2E Guest');
    await page.locator('#phoneField').fill('9000000000');
    await page.locator('#consentCheck').check();
    await page.locator('#submitBtn').click();
    await expect(page.getByText('Complaint Submitted!')).toBeVisible();
    await ctx.close();

    const t = await db().ticket.findFirst({ where: { description: marker } });
    expect(t).toBeTruthy();
    expect(t.orgId).toBe(s.orgA.id);
    expect(t.locationId).toBe(state.location.id);
    expect(t.source).toBe('PUBLIC');
    expect(t.status).toBe('OPEN');
    expect(t.imageUrl).toMatch(/^\/images\/uploads\//);
    // F2: the nearer supervisor (assigned to the floor) wins over the farther one
    // (assigned to the building), even though the farther one was assigned first.
    expect(t.assignedToId).toBe(s.supNear.id);
    state.ticket = t;

    // Electricians: exactly the two whose assignments cover the room.
    const covering = [s.workers.elecFloor.id, s.workers.elecBlock.id].sort();
    await expect.poll(async () => (await db().notification.findMany({
      where: { entityId: t.id, workerId: { not: null } }, select: { workerId: true }
    })).map((n) => n.workerId).sort()).toEqual(covering);

    // F3: wait for the org-wide broadcast (the last notification step) to land on the
    // unassigned supervisor, then each assigned supervisor must still have exactly one.
    await expect.poll(() => db().notification.count({ where: { entityId: t.id, userId: s.supOther.id } })).toBe(1);
    expect(await db().notification.count({ where: { entityId: t.id, userId: s.supNear.id } })).toBe(1);
    expect(await db().notification.count({ where: { entityId: t.id, userId: s.supFar.id } })).toBe(1);
    expect(await db().notification.count({ where: { entityId: t.id, orgId: s.orgB.id } })).toBe(0);
    expect(await db().notification.count({ where: { orgId: s.orgB.id, userId: s.supB.id } })).toBe(0);
  });

  test('J3 — admin adds an electrician with an employee ID and PIN 123456; they sign in on a phone and see the complaint in the pool', async ({ page, browser }) => {
    await signIn(page, 'admin', s.adminA, s.orgA.slug);
    await page.goto(orgPage(s.orgA.slug, 'admin-workers'));
    await page.getByRole('button', { name: '+ Add Electrician' }).click();
    const name = `E2E New Elec ${s.run}`;
    const employeeId = `E2E-NEW-${s.run}`;
    await page.locator('#wName').fill(name);
    await page.locator('#wEmpId').fill(employeeId);
    await page.locator('#saveBtn').click();
    const row = page.locator('tr', { hasText: name });
    await expect(row).toBeVisible();
    await row.locator('button[title="Set login PIN"]').click();
    await page.locator('#pinInput').fill('123456');
    await page.locator('#pinConfirm').fill('123456');
    await page.locator('#pinSaveBtn').click();

    await expect.poll(async () => {
      const w = await db().worker.findFirst({ where: { orgId: s.orgA.id, employeeId } });
      return Boolean(w && w.pinHash);
    }).toBe(true);
    const worker = await db().worker.findFirst({ where: { orgId: s.orgA.id, employeeId } });
    state.newWorker = { id: worker.id, employeeId };

    // Coverage assignment is not part of this journey's UI; set it through the admin API.
    const { token } = await apiLogin(page.request, s.adminA);
    const assign = await page.request.put(`/api/workers/${worker.id}/assignments`, {
      headers: { authorization: `Bearer ${token}` },
      data: { locationIds: [s.locations.floor], coverChildren: true }
    });
    expect(assign.ok()).toBeTruthy();

    const ctx = await browser.newContext(mobile());
    const m = await ctx.newPage();
    await m.goto(orgPage(s.orgA.slug, 'electrician-login'));
    await m.locator('#employeeId').fill(employeeId);
    await m.locator('#pin').fill('123456');
    await m.locator('#btn').click();
    await m.waitForURL(/electrician-scan/);
    await m.goto(orgPage(s.orgA.slug, 'electrician-tickets'));
    const card = m.locator('.el-card', { hasText: state.ticket.description });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /Pick Up/ })).toBeVisible();
    // F15: the electrician sees the guest's photo (the image proxy accepts worker tokens),
    // and loading it does not trip the database breaker for everyone else.
    const complaintPhoto = card.locator('img.el-img').first();
    await expect.poll(() => complaintPhoto.evaluate((img) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
    state.elecContext = ctx;
    state.elecPage = m;
  });

  test('J4 — the electrician picks it up and resolves it with a proof photo → RESOLVED_PENDING_VERIFY', async () => {
    const m = state.elecPage;
    // Pick Up asks for confirmation with a native confirm(); accept it as the user would.
    const confirmed = new Promise((resolve) => m.once('dialog', async (d) => { const msg = d.message(); await d.accept(); resolve(msg); }));
    const pickupResponse = m.waitForResponse((r) => r.url().includes('/pickup') && r.request().method() === 'POST');
    await m.locator('.el-card', { hasText: state.ticket.description }).getByRole('button', { name: /Pick Up/ }).click();
    expect(await confirmed).toMatch(/Pick up this ticket/);
    const picked = await pickupResponse;
    expect(picked.status(), `pickup answered ${picked.status()}: ${await picked.text()}`).toBe(200);
    await expect.poll(async () => (await db().ticket.findUnique({ where: { id: state.ticket.id } })).status).toBe('IN_PROGRESS');

    const active = m.locator('.el-card', { hasText: state.ticket.description });
    await active.getByRole('button', { name: /Resolve With Photo/ }).click();
    await m.locator('#rNote').fill(`Replaced the fitting (${s.run})`);
    await m.locator('#rPhoto').setInputFiles(photo('proof.png'));
    await m.locator('#resolveBtn').click();

    await expect.poll(async () => (await db().ticket.findUnique({ where: { id: state.ticket.id } })).status).toBe('RESOLVED_PENDING_VERIFY');
    const t = await db().ticket.findUnique({ where: { id: state.ticket.id }, include: { resolvedWorkers: { select: { id: true } } } });
    expect(t.resolvedImageUrl).toMatch(/^\/images\/uploads\//);
    expect(t.resolvedWorkers.map((w) => w.id)).toContain(state.newWorker.id);
    // A resolved ticket leaves the Active tab and waits under "To Verify".
    await m.locator('.filter-tab[data-tab="verify"]').click();
    await expect(m.locator('.el-card', { hasText: state.ticket.description })).toContainText('Awaiting supervisor verification');
  });

  test('J5 — the assigned supervisor signs in, verifies and closes it → RESOLVED; the guest review link loads', async ({ page }) => {
    await page.goto(orgPage(s.orgA.slug, 'supervisor-login'));
    await page.locator('#email').fill(s.supNear.email);
    await page.locator('#password').fill(s.supNear.password);
    await page.locator('#submitBtn').click();
    await page.waitForURL(/supervisor-scan/);
    await page.goto(orgPage(s.orgA.slug, 'supervisor-tickets'));
    await page.locator('.sv-tab[data-status="RESOLVED_PENDING_VERIFY"]').click();
    await page.locator('.tk-card', { hasText: state.location.name }).first().click();
    await page.getByRole('button', { name: /Verify & Close/ }).click();

    await expect.poll(async () => (await db().ticket.findUnique({ where: { id: state.ticket.id } })).status).toBe('RESOLVED');
    const t = await db().ticket.findUnique({ where: { id: state.ticket.id } });
    expect(t.verifiedById).toBe(s.supNear.id);

    if (t.reviewToken) {
      const api = await page.request.get(`/api/public/review/${t.reviewToken}`);
      expect(api.status()).toBe(200);
      await page.goto(`/review/${t.reviewToken}`);
      await expect(page.getByText('Your Complaint')).toBeVisible();
    } else {
      test.info().annotations.push({ type: 'note', description: 'no guest review link was produced for this ticket' });
    }
  });

  test('J6 — admin raises an internal ticket; it shows in the admin list and in the assigned supervisor\'s list', async ({ page, browser }) => {
    await signIn(page, 'admin', s.adminA, s.orgA.slug);
    await page.goto(orgPage(s.orgA.slug, 'admin-tickets'));
    await page.getByRole('button', { name: '+ New Ticket' }).click();
    const title = `E2E internal ${s.run}`;
    await page.locator('#cTitle').fill(title);
    await pickOption(page, 'cLocation', state.location.name, { exact: false });
    await page.locator('#createForm button[type=submit]').click();
    await expect(page.locator('.tk-title-cell', { hasText: title })).toBeVisible();

    await expect.poll(async () => (await db().ticket.findFirst({ where: { orgId: s.orgA.id, title } })) !== null).toBe(true);
    const t = await db().ticket.findFirst({ where: { orgId: s.orgA.id, title } });
    expect(t.source).not.toBe('PUBLIC');
    expect(t.locationId).toBe(state.location.id);
    expect(t.assignedToId).toBe(s.supNear.id);

    const ctx = await browser.newContext();
    const sup = await ctx.newPage();
    await signIn(sup, 'supervisor', s.supNear, s.orgA.slug);
    await sup.goto(orgPage(s.orgA.slug, 'supervisor-tickets'));
    await sup.locator('.sv-tab[data-status="OPEN"]').click();
    await expect(sup.locator('.tk-card', { hasText: title })).toBeVisible();
    await ctx.close();
  });
});

test.describe('J7 — negative cases', () => {
  let s;
  test.beforeAll(() => { s = seed(); });

  test('an electrician cannot open admin pages or call admin APIs', async ({ page }) => {
    const login = await page.request.post('/api/auth/worker-login', {
      data: { orgSlug: s.orgA.slug, employeeId: s.workers.elecFloor.employeeId, pin: s.workers.elecFloor.pin }
    });
    expect(login.status()).toBe(200);
    const { token, worker } = await login.json();
    await page.addInitScript(({ token, worker, slug }) => {
      localStorage.setItem('elec_token', token);
      localStorage.setItem('elec_user', JSON.stringify(worker || {}));
      localStorage.setItem('orgSlug', slug);
    }, { token, worker, slug: s.orgA.slug });
    await page.goto(orgPage(s.orgA.slug, 'admin-dashboard'));
    await expect(page).toHaveURL(/admin-login/);
    const api = await page.request.get('/api/tickets', { headers: { authorization: `Bearer ${token}` } });
    expect([401, 403]).toContain(api.status());
  });

  test('org B cannot see an org A ticket, in the API or in its ticket list', async ({ page }) => {
    const title = `E2E org A only ${s.run}`;
    const ticket = await factories().createTestTicket(s.orgA.id, s.locations.building, { title });
    const { token } = await apiLogin(page.request, s.adminB);
    const direct = await page.request.get(`/api/tickets/${ticket.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(direct.status()).toBe(404);

    await signIn(page, 'admin', s.adminB, s.orgB.slug);
    await page.goto(orgPage(s.orgB.slug, 'admin-tickets'));
    await expect(page.locator('#ticketBody')).toBeVisible();
    await expect(page.locator('#ticketBody tr').first()).toBeVisible();
    await expect(page.locator('.tk-title-cell', { hasText: title })).toHaveCount(0);
  });

  test('a wrong PIN shows an error and does not sign in', async ({ page }) => {
    await page.goto(orgPage(s.orgA.slug, 'electrician-login'));
    await page.locator('#employeeId').fill(s.workers.elecFloor.employeeId);
    await page.locator('#pin').fill(s.workers.elecFloor.pin === '000000' ? '111111' : '000000');
    await page.locator('#btn').click();
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error')).not.toBeEmpty();
    await expect(page).toHaveURL(/electrician-login/);
    expect(await page.evaluate(() => localStorage.getItem('elec_token'))).toBeNull();
  });

  test('an invalid complaint shows a validation error and creates no ticket', async ({ browser }) => {
    // QR codes are 4–20 characters, matched upper-case (public.js); the factory default is longer.
    const room = await factories().createTestLocation(s.orgA.id, {
      name: `E2E J7 Room ${s.run}`, type: 'ROOM', parentId: s.locations.floor, qrCode: `E2EJ7${s.run}`.toUpperCase()
    });
    const ctx = await browser.newContext(mobile());
    const page = await ctx.newPage();
    await page.goto(`/s/${room.qrCode}`);
    await page.locator('.issue-opt[data-issue="FAN_NOT_WORKING"]').click();
    await page.locator('#nameField').fill('No Consent Given');
    await page.locator('#submitBtn').click();
    await expect(page.locator('#formError')).toBeVisible();
    await expect(page.locator('#formError')).toContainText('consent');
    await ctx.close();
    expect(await db().ticket.count({ where: { locationId: room.id } })).toBe(0);
  });
});

// BUG-0010: the electrician/supervisor nav links were rewritten twice — once when the page
// initialised and again after /auth/worker-me (/auth/me) returned — and the second pass
// prefixed an already-prefixed link: /{org}/ele/{org}/ele/{page}, a 404 in production. The
// journeys above navigate with page.goto, so they never clicked the nav. These tests wait for
// that module sync to finish, then check every href and click through the links.
test.describe('BUG-0010 — role nav links after module sync', () => {
  let s;
  test.beforeAll(() => { s = seed(); });

  // The sync's last step (setEnabledModules, then the nav rewrite, in one synchronous block)
  // writes localStorage.enabledModules. The init script removes it on every page load, so it
  // reappearing means this page's sync — and its nav rewrite — has run. No fixed sleep.
  const clearEnabledModules = (page) => page.addInitScript(() => localStorage.removeItem('enabledModules'));
  async function syncDone(page, sync) {
    await sync;
    await expect.poll(() => page.evaluate(() => localStorage.getItem('enabledModules'))).not.toBeNull();
  }
  const meResponse = (page, mePath) => page.waitForResponse((r) => new URL(r.url()).pathname === mePath && r.status() === 200);

  // No href may carry the org twice, and the visible links are exactly /{slug}/ele/{page}.
  async function expectNavHrefs(page, slug, pages) {
    const links = await page.$$eval('#sv-nav a[href]', (as) => as.map((a) => ({ href: a.getAttribute('href'), hidden: a.style.display === 'none' })));
    const doubled = links.filter((l) => l.href.split(`/${slug}/`).length > 2);
    expect(doubled, `nav hrefs carry the org twice: ${doubled.map((l) => l.href).join(', ')}`).toEqual([]);
    expect(links.filter((l) => !l.hidden).map((l) => l.href).sort()).toEqual(pages.map((p) => `/${slug}/ele/${p}`).sort());
  }

  // Click a nav link by its label: the document response must be 200 at /{slug}/ele/{page}.
  // `landsOn`: a page that sends you on by design (supervisor-electrical without a scanned
  // location goes back to supervisor-scan); the click itself must still be a 200 at the link.
  async function clickNav(page, slug, label, pageName, mePath, landmark, landsOn = pageName) {
    const target = `/${slug}/ele/${pageName}`;
    const landing = `/${slug}/ele/${landsOn}`;
    const sync = meResponse(page, mePath);
    const [doc] = await Promise.all([
      page.waitForResponse((r) => r.request().isNavigationRequest() && r.request().resourceType() === 'document'),
      page.locator('#sv-nav').getByRole('link', { name: label, exact: true }).click()
    ]);
    expect(new URL(doc.url()).pathname, `${label} navigated to ${new URL(doc.url()).pathname}`).toBe(target);
    expect(doc.status(), `${label} answered ${doc.status()}`).toBe(200);
    await expect.poll(() => new URL(page.url()).pathname).toBe(landing);
    await expect(page.getByRole('heading', { name: landmark })).toBeVisible();
    await syncDone(page, sync);
  }

  test('electrician nav links work after module sync (BUG-0010)', async ({ page }) => {
    const slug = s.orgA.slug;
    const login = await page.request.post('/api/auth/worker-login', {
      data: { orgSlug: slug, employeeId: s.workers.elecFloor.employeeId, pin: s.workers.elecFloor.pin }
    });
    expect(login.status()).toBe(200);
    const { token, worker } = await login.json();
    await page.addInitScript(({ token, worker, slug }) => {
      localStorage.setItem('elec_token', token);
      localStorage.setItem('elec_user', JSON.stringify(worker || {}));
      localStorage.setItem('orgSlug', slug);
    }, { token, worker, slug });
    await clearEnabledModules(page);

    const ME = '/api/auth/worker-me';
    const NAV = ['electrician-scan', 'electrician-tickets', 'electrician-my-work'];
    const sync = meResponse(page, ME);
    await page.goto(orgPage(slug, 'electrician-scan'));
    await syncDone(page, sync);
    await expectNavHrefs(page, slug, NAV);

    await clickNav(page, slug, 'Tickets', 'electrician-tickets', ME, 'Electrician Work Queue');
    await expectNavHrefs(page, slug, NAV);
    await clickNav(page, slug, 'My Work', 'electrician-my-work', ME, 'My Work — Last 30 Days');
    await expectNavHrefs(page, slug, NAV);
    await clickNav(page, slug, 'Scan', 'electrician-scan', ME, 'Scan Location QR');
    await expectNavHrefs(page, slug, NAV);
  });

  test('supervisor nav links work after module sync (BUG-0010)', async ({ page }) => {
    const slug = s.orgA.slug;
    await signIn(page, 'supervisor', s.supNear, slug);
    await clearEnabledModules(page);

    const ME = '/api/auth/me';
    // The scan and electrical pages also link Electrical; tickets and attendance do not.
    const NAV = ['supervisor-scan', 'supervisor-electrical', 'supervisor-tickets', 'supervisor-attendance'];
    const NAV_SHORT = ['supervisor-scan', 'supervisor-tickets', 'supervisor-attendance'];
    const sync = meResponse(page, ME);
    await page.goto(orgPage(slug, 'supervisor-scan'));
    await syncDone(page, sync);
    await expectNavHrefs(page, slug, NAV);

    await clickNav(page, slug, 'Electrical', 'supervisor-electrical', ME, 'Scan Location QR', 'supervisor-scan');
    await expectNavHrefs(page, slug, NAV);
    await clickNav(page, slug, 'Tickets', 'supervisor-tickets', ME, 'My Tickets');
    await expectNavHrefs(page, slug, NAV_SHORT);
    await clickNav(page, slug, 'Attendance', 'supervisor-attendance', ME, 'Attendance');
    await expectNavHrefs(page, slug, NAV_SHORT);
    await clickNav(page, slug, 'Scan', 'supervisor-scan', ME, 'Scan Location QR');
    await expectNavHrefs(page, slug, NAV);

    // A link for a module the org has not enabled (assets) stays hidden after the sync.
    const assetsSync = meResponse(page, ME);
    await page.goto(orgPage(slug, 'supervisor-assets'));
    await syncDone(page, assetsSync);
    await expect(page.locator('#sv-nav a[data-mod="asset"]')).toBeHidden();
    await expectNavHrefs(page, slug, NAV_SHORT);
  });
});
