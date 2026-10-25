'use strict';

// Every button and form on the role pages — the explorer only follows links and tabs. For each
// form: an invalid submit shows the server's (or the page's) error and changes nothing; a valid
// one shows the change and it survives a reload; destructive actions (deactivate, delete, the
// 409 rules) behave as the API says. Runs in the explorer org (asset module on), desktop project
// only; every name is unique to the run. Asserts what the user sees AND the database behind it.

const { test, expect } = require('@playwright/test');
const { seed, db, apiLogin, signIn, signInElectrician, orgPage, pickOption } = require('../support/app');

const confirmYes = (page) => page.locator('#_cfmYes').click();

test.describe('Forms — admin, supervisor, electrician', () => {
  let s, x, slug;
  test.beforeAll(() => { s = seed(); x = s.explorer; slug = x.org.slug; });

  test('electricians: a duplicate employee ID is refused; create, edit and PIN survive a reload; deactivate; delete', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-workers'));
    const name = `Form Elec ${s.run}`;
    const emp = `FORM-E-${s.run}`;

    await page.getByRole('button', { name: '+ Add Electrician' }).click();
    await page.locator('#wName').fill(name);
    await page.locator('#wEmpId').fill(x.worker.employeeId);
    await page.locator('#saveBtn').click();
    await expect(page.locator('#modalError')).toContainText('employee ID already exists');
    await page.locator('#wEmpId').fill(emp);
    await page.locator('#saveBtn').click();
    const row = page.locator('#workerBody tr', { hasText: emp });
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#wDesig').fill('Senior Electrician');
    await page.locator('#saveBtn').click();
    await expect.poll(async () => (await db().worker.findFirst({ where: { employeeId: emp } })).designation).toBe('Senior Electrician');
    await page.reload();
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#wDesig')).toHaveValue('Senior Electrician');
    await page.reload();

    await row.getByRole('button', { name: /PIN/ }).click();
    await page.locator('#pinInput').fill('12345');
    await page.locator('#pinConfirm').fill('12345');
    await page.locator('#pinModal').getByRole('button', { name: /Set PIN|Save/ }).click();
    await expect(page.locator('#pinError')).toContainText('6 digits');
    await page.locator('#pinInput').fill('246813');
    await page.locator('#pinConfirm').fill('246813');
    await page.locator('#pinModal').getByRole('button', { name: /Set PIN|Save/ }).click();
    await expect.poll(async () => Boolean((await db().worker.findFirst({ where: { employeeId: emp } })).pinHash)).toBe(true);

    await row.getByRole('button', { name: 'Deactivate' }).click();
    await confirmYes(page);
    await expect.poll(async () => (await db().worker.findFirst({ where: { employeeId: emp } })).isActive).toBe(false);
    await page.locator('#showInactive').check();
    await row.getByRole('button', { name: 'Delete' }).click();
    await confirmYes(page);
    await expect.poll(async () => db().worker.count({ where: { employeeId: emp } })).toBe(0);
    await page.reload();
    await page.locator('#showInactive').check();
    await expect(row).toHaveCount(0);
  });

  test('supervisors: a duplicate email is refused; a short password is refused; delete with history shows the 409 reason and keeps them', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-supervisors'));
    const name = `Form Sup ${s.run}`;
    const email = `form-sup-${s.run}@example.test`;

    await page.getByRole('button', { name: '+ Add Supervisor' }).click();
    await page.locator('#sName').fill(name);
    await page.locator('#sEmail').fill(x.supervisor.email);
    await page.locator('#sPassword').fill('FormSup123!');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#modalError')).toBeVisible();
    await expect(page.locator('#modalError')).not.toBeEmpty();
    await page.locator('#sEmail').fill(email);
    await page.locator('#saveBtn').click();
    const row = page.locator('#supBody tr', { hasText: email });
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();

    // Long enough for the field's own minlength, but against the server's rule (no capital):
    // the server's reason must be shown, and the password must not change.
    const before = (await db().user.findFirst({ where: { email } })).passwordHash;
    await row.getByRole('button', { name: 'PW' }).click();
    await page.locator('#pwNew').fill('alllowercase1');
    await page.locator('#resetBtn').click();
    await expect(page.locator('#pwError')).toBeVisible();
    await expect(page.locator('#pwError')).not.toBeEmpty();
    expect((await db().user.findFirst({ where: { email } })).passwordHash).toBe(before);
    await page.locator('#pwNew').fill('NewSupPass123');
    await page.locator('#resetBtn').click();
    await expect.poll(async () => (await db().user.findFirst({ where: { email } })).passwordHash).not.toBe(before);
    await page.reload();

    // History: a ticket this supervisor created (ON DELETE RESTRICT — BUG-0009's 409 rule).
    const sup = await db().user.findFirst({ where: { email } });
    await db().ticket.create({ data: { orgId: x.org.id, locationId: x.locationId, title: `Form history ${s.run}`, createdById: sup.id, source: 'INTERNAL', module: 'ele' } });
    await row.getByRole('button', { name: 'Deactivate' }).click();
    await confirmYes(page);
    await expect.poll(async () => (await db().user.findUnique({ where: { id: sup.id } })).isActive).toBe(false);
    await page.locator('#showInactive').check();
    await row.getByRole('button', { name: 'Delete' }).click();
    await confirmYes(page);
    await expect(page.locator('.toast', { hasText: 'Cannot permanently delete supervisor' })).toBeVisible();
    expect(await db().user.count({ where: { id: sup.id } })).toBe(1);
  });

  test('BUG-0021: clearing an asset\'s optional details on edit is saved (make, warranty, cost)', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-assets'));
    const code = `FORM-A-${s.run}`;

    await page.getByRole('button', { name: '+ Add Asset' }).click();
    await page.locator('#fAssetCode').fill(code);
    await page.locator('#fName').fill(`Form Panel ${s.run}`);
    await page.locator('#fCategoryInput').selectOption({ index: 1 });
    await page.locator('#fLocationInput').selectOption(x.locationId);
    await page.locator('#fMake').fill('Schneider');
    await page.locator('#fWarrantyExpiry').fill('2030-01-31');
    await page.locator('#fPurchaseCost').fill('12500');
    await page.locator('#saveBtn').click();
    await expect.poll(async () => (await db().asset.findFirst({ where: { orgId: x.org.id, assetCode: code } }))?.make).toBe('Schneider');

    // A duplicate asset code is refused with the server's message.
    await page.getByRole('button', { name: '+ Add Asset' }).click();
    await page.locator('#fAssetCode').fill(code);
    await page.locator('#fName').fill('Duplicate');
    await page.locator('#fCategoryInput').selectOption({ index: 1 });
    await page.locator('#fLocationInput').selectOption(x.locationId);
    await page.locator('#saveBtn').click();
    await expect(page.locator('#modalError')).toContainText(/already exists/i);
    await page.reload();

    const openEdit = async () => {
      await page.locator('tr', { hasText: code }).getByRole('button', { name: 'View' }).click();
      await page.locator('#editFromDetailBtn').click();
    };
    await openEdit();
    await expect(page.locator('#fMake')).toHaveValue('Schneider');
    await page.locator('#fMake').fill('');
    await page.locator('#fWarrantyExpiry').fill('');
    await page.locator('#fPurchaseCost').fill('');
    await page.locator('#saveBtn').click();
    await expect.poll(async () => {
      const a = await db().asset.findFirst({ where: { orgId: x.org.id, assetCode: code } });
      return [a.make, a.warrantyExpiry, a.purchaseCost];
    }).toEqual([null, null, null]);
    await page.reload();
    await openEdit();
    await expect(page.locator('#fMake')).toHaveValue('');
    await expect(page.locator('#fWarrantyExpiry')).toHaveValue('');
    await expect(page.locator('#fPurchaseCost')).toHaveValue('');
  });

  test('BUG-0021: a location\'s notes can be cleared and it can be moved back to the top level', async ({ page }) => {
    const f = require('../../apps/api/scenarios/factories');
    const parent = await f.createTestLocation(x.org.id, { name: `Form Block ${s.run}`, type: 'BUILDING' });
    const room = await f.createTestLocation(x.org.id, { name: `Form Room ${s.run}`, type: 'ROOM', parentId: parent.id, notes: 'Key with the warden' });
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-locations'));

    const card = page.locator(`.room-card[data-id="${room.id}"]`);
    await card.locator('[data-action="edit"]').click();
    await expect(page.locator('#locNotes')).toHaveValue('Key with the warden');
    await page.locator('#locNotes').fill('');
    // "— None (Top Level) —" has the empty value, so pick it by hand (pickOption expects a value).
    await page.locator('.cs-wrap', { has: page.locator('#locParent') }).locator('.cs-trigger').click();
    await page.locator('#cs-list-locParent .cs-option', { hasText: 'None (Top Level)' }).click();
    await expect(page.locator('#locParent')).toHaveValue('');
    await page.locator('#locForm button[type=submit]').click();
    await expect.poll(async () => {
      const l = await db().location.findUnique({ where: { id: room.id } });
      return [l.notes || null, l.parentId];
    }).toEqual([null, null]);
  });

  // The form offered only Notify Admins / Notify Supervisors / Create Ticket; the API also takes
  // "notify the location's supervisors / electricians" (what BUG-0019 made escalations reach).
  // Editing a rule that had them rebuilt the actions from the checkboxes and dropped them,
  // silently. [BUG-0043]
  test('BUG-0043: editing an alert rule keeps its "location\'s supervisors / electricians" actions', async ({ page }) => {
    const name = `Form Rule 43 ${s.run}`;
    await db().alertRule.create({
      data: {
        orgId: x.org.id, name, trigger: 'TICKET_HIGH_PRIORITY', conditions: {},
        actions: [{ type: 'NOTIFY_ADMINS' }, { type: 'NOTIFY_ASSIGNED_SUPERVISORS' }],
        escalateAfterMinutes: 30, maxEscalations: 1, escalationActions: [{ type: 'NOTIFY_ASSIGNED_WORKERS' }]
      }
    });
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-alerts'));
    const card = page.locator('.rule-card', { hasText: name });
    await expect(card).toContainText('Location Supervisors');
    await card.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#actNotifyAssignedSups')).toBeChecked();
    await expect(page.locator('#escNotifyAssignedWorkers')).toBeChecked();
    await page.locator('#rfDesc').fill('Edited');
    await page.locator('#ruleSubmitBtn').click();
    await expect.poll(async () => (await db().alertRule.findFirst({ where: { orgId: x.org.id, name } })).description).toBe('Edited');
    const saved = await db().alertRule.findFirst({ where: { orgId: x.org.id, name } });
    expect(saved.actions.map((a) => a.type).sort()).toEqual(['NOTIFY_ADMINS', 'NOTIFY_ASSIGNED_SUPERVISORS']);
    expect(saved.escalationActions.map((a) => a.type)).toEqual(['NOTIFY_ASSIGNED_WORKERS']);
  });

  test('BUG-0021: an alert rule\'s description can be cleared; a rule needs a trigger; acknowledging an alert', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-alerts'));
    const name = `Form Rule ${s.run}`;

    await page.getByRole('button', { name: '+ New Rule' }).click();
    await page.locator('#rfName').fill(name);
    await page.locator('#ruleSubmitBtn').click();
    await expect(page.locator('#ruleError')).toContainText('trigger');
    await page.locator('.trigger-opt[data-trigger="TICKET_HIGH_PRIORITY"]').click();
    await page.locator('#rfDesc').fill('Wake the duty officer');
    await page.locator('#ruleSubmitBtn').click();
    const card = page.locator('.rule-card', { hasText: name });
    await expect(card).toContainText('Wake the duty officer');
    await page.reload();
    await card.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#rfDesc').fill('');
    await page.locator('#ruleSubmitBtn').click();
    await expect.poll(async () => (await db().alertRule.findFirst({ where: { orgId: x.org.id, name } })).description || null).toBeNull();
    await page.reload();
    await expect(page.locator('.rule-card', { hasText: name })).not.toContainText('Wake the duty officer');

    // Acknowledge an alert.
    const rule = await db().alertRule.findFirst({ where: { orgId: x.org.id, name } });
    const alert = await db().alert.create({ data: { orgId: x.org.id, ruleId: rule.id, trigger: 'TICKET_HIGH_PRIORITY', severity: 'WARNING', title: `Form alert ${s.run}` } });
    await page.reload();
    await page.locator('.tab', { hasText: 'Alert History' }).click();
    const alertCard = page.locator('.alert-card', { hasText: `Form alert ${s.run}` });
    await alertCard.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(alertCard).toContainText('Acked');
    await expect.poll(async () => (await db().alert.findUnique({ where: { id: alert.id } })).acknowledged).toBe(true);
  });

  test('BUG-0022: on a browser that cannot scan QR codes, the camera is not left on, and the code typed by hand finds the location and its tickets', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // An iPhone-like browser: a camera, but no BarcodeDetector.
    await page.addInitScript(() => {
      delete window.BarcodeDetector;
      window.__cameraOpened = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__cameraOpened++;
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 48;
        return canvas.captureStream(5);
      };
    });
    await signInElectrician(page, x.worker, slug);
    await page.goto(orgPage(slug, 'electrician-scan'));
    await page.locator('#startBtn').click();
    await expect(page.locator('#cameraError')).toContainText(/enter (the )?code manually/i);
    expect(await page.evaluate(() => window.__cameraOpened), 'the camera is not opened when nothing can scan').toBe(0);
    await expect(page.locator('#videoWrap')).toBeHidden();

    await page.locator('#manualCode').fill(x.qrCode.toLowerCase());
    await page.getByRole('button', { name: 'Look Up' }).click();
    await expect(page.locator('#locationCard')).toContainText('Your Coverage');
    await page.locator('#locationCard a', { hasText: 'View Tickets at this Location' }).click();
    await expect(page).toHaveURL(new RegExp(`locationId=${x.locationId}`));
    await expect(page.locator('.el-card', { hasText: `E2E X open ticket ${s.run}` })).toBeVisible();
    await ctx.close();
  });

  test('complaint categories: a name is required; create, edit, switch off and delete survive a reload', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-categories'));
    const name = `Form Category ${s.run}`;
    const find = () => db().complaintCategory.findFirst({ where: { orgId: x.org.id, name } });

    await page.getByRole('button', { name: '+ Add Category' }).click();
    await page.locator('#saveBtn').click();
    await expect(page.locator('#modalError')).toContainText('name is required');
    await page.locator('#catName').fill(name);
    await page.locator('#saveBtn').click();
    const row = page.locator('#rows tr', { hasText: name });
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#catDesc').fill('Shown to the guest');
    await page.locator('#catActive').uncheck();
    await page.locator('#saveBtn').click();
    await expect.poll(async () => { const c = await find(); return [c.description, c.isActive]; }).toEqual(['Shown to the guest', false]);

    await page.reload();
    await page.locator('#showInactive').check();
    await row.getByRole('button', { name: 'Delete' }).click();
    await confirmYes(page);
    await expect.poll(async () => (await find()) === null).toBe(true);
  });

  test('inspection templates: a name and an item are required; create, duplicate and delete', async ({ page }) => {
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-templates'));
    const name = `Form Template ${s.run}`;

    await page.getByRole('button', { name: '+ New Template' }).click();
    await page.locator('#tplSaveBtn').click();
    await expect(page.locator('#tplError')).toContainText('name is required');
    await page.locator('#tplName').fill(name);
    if (await page.locator('#itemsList .item-label-input').count() === 0) await page.locator('#tplModal').getByRole('button', { name: '+ Add Item' }).click();
    await page.locator('#itemsList .item-label-input').first().fill('Earthing continuity');
    await page.locator('#tplSaveBtn').click();
    const card = page.locator('.tpl-card', { hasText: name }).first();
    await expect(card).toBeVisible();
    const tpl = await db().inspectionTemplate.findFirst({ where: { orgId: x.org.id, name }, include: { items: true } });
    expect(tpl.items.map((i) => i.checkKey)).toEqual(['EARTHING_CONTINUITY']);

    await card.getByRole('button', { name: 'Duplicate' }).click();
    await expect.poll(() => db().inspectionTemplate.count({ where: { orgId: x.org.id, name: { startsWith: name } } })).toBe(2);
    await page.reload();
    await page.locator('.tpl-card', { hasText: name }).first().getByRole('button', { name: 'Delete' }).click();
    await confirmYes(page);
    await expect.poll(() => db().inspectionTemplate.count({ where: { orgId: x.org.id, name: { startsWith: name }, isActive: true } })).toBe(1);
  });

  test('asset failures: report one (the asset turns FAULTY), then resolve it (OPERATIONAL again)', async ({ page }) => {
    const f = require('../../apps/api/scenarios/factories');
    const asset = await f.createTestAsset(x.org.id, x.locationId, { name: `Form Pump ${s.run}`, assetCode: `FORM-P-${s.run}` });
    await signIn(page, 'admin', x.admin, slug);
    await page.goto(orgPage(slug, 'admin-failures'));
    const title = `Form seal leak ${s.run}`;

    await page.getByRole('button', { name: '+ Report Failure' }).click();
    await page.locator('#rAsset').selectOption(asset.id);
    await page.locator('#rTitle').fill(title);
    await page.locator('#reportBtn').click();
    await expect.poll(async () => (await db().asset.findUnique({ where: { id: asset.id } })).status).toBe('FAULTY');
    const row = page.locator('tr', { hasText: title });
    await page.reload();
    await row.getByRole('button', { name: 'View' }).click();
    await page.locator('#dStatus').selectOption('RESOLVED');
    await page.locator('#dResolution').fill('Replaced the seal');
    await page.locator('#updateStatusBtn').click();
    await expect.poll(async () => (await db().assetFailure.findFirst({ where: { assetId: asset.id, title } })).status).toBe('RESOLVED');
    await expect.poll(async () => (await db().asset.findUnique({ where: { id: asset.id } })).status).toBe('OPERATIONAL');
  });

  test('BUG-0024: supervisor › assets: find an asset, log an inspection and report a failure — each shows its confirmation', async ({ page }) => {
    const f = require('../../apps/api/scenarios/factories');
    const asset = await f.createTestAsset(x.org.id, x.locationId, { name: `Form Meter ${s.run}`, assetCode: `FORM-M-${s.run}` });
    await signIn(page, 'supervisor', x.supervisor, slug);
    await page.goto(orgPage(slug, 'supervisor-assets'));
    await page.locator('#assetSearch').fill(asset.assetCode);
    await page.locator('#assetResults').getByText(asset.assetCode).click();
    await expect(page.locator('#assetView')).toBeVisible();

    await page.getByRole('button', { name: /Log Inspection/ }).click();
    await page.locator('#eSummary').fill(`Form inspection ${s.run}`);
    await page.locator('#eventSubmitBtn').click();
    await expect.poll(() => db().assetEvent.count({ where: { assetId: asset.id, summary: `Form inspection ${s.run}` } })).toBe(1);
    // The confirmation is shown (it used to be a blank page), and leads back to the asset.
    await expect(page.locator('#successView')).toBeVisible();
    await expect(page.locator('#successTitle')).toHaveText('Event Logged!');
    await page.getByRole('button', { name: 'Back to Asset' }).click();
    await expect(page.locator('#assetView')).toBeVisible();

    await page.getByRole('button', { name: /Report Failure/ }).click();
    await page.locator('#ffTitle').fill(`Form meter fault ${s.run}`);
    await page.locator('#failureSubmitBtn').click();
    await expect.poll(() => db().assetFailure.count({ where: { assetId: asset.id, title: `Form meter fault ${s.run}` } })).toBe(1);
    await expect(page.locator('#successView')).toBeVisible();
    await expect(page.locator('#successTitle')).toHaveText('Failure Reported!');
  });

  test('BUG-0025: supervisor › attendance: start a roster for a location, keep the suggested electrician, mark everyone present', async ({ page }) => {
    await signIn(page, 'supervisor', x.supervisor, slug);
    await page.goto(orgPage(slug, 'supervisor-attendance'));
    await page.locator('.setup-loc-item').first().click();
    await page.locator('#startRosterBtn').click();
    await expect(page.locator('#workerModal')).toBeVisible();
    // The electrician covering the location is suggested and pre-selected for a new roster.
    await expect(page.locator('#wsList input:checked')).not.toHaveCount(0);
    await page.locator('#wsSaveBtn').click();
    await expect(page.locator('#attendView')).toBeVisible();
    await page.getByRole('button', { name: /All Present/ }).click();
    await page.locator('#submitBtn').click();
    await expect.poll(() => db().attendance.count({ where: { orgId: x.org.id, workerId: x.worker.id, status: 'PRESENT' } })).toBeGreaterThan(0);
  });

  test('supervisor › a code typed by hand opens the inspection; incomplete items are refused; the submission can be flagged by the admin', async ({ page, browser }) => {
    await signIn(page, 'supervisor', x.supervisor, slug);
    await page.goto(orgPage(slug, 'supervisor-scan'));
    await page.locator('#manualCode').fill(x.qrCode);
    await page.getByRole('button', { name: 'Look Up' }).click();
    await page.locator('#locationCard a', { hasText: /Electrical Inspection/ }).click();
    await expect(page).toHaveURL(/supervisor-electrical\?locationId=/);
    await expect(page.locator('#checklist .check-btn').first()).toBeVisible();

    await page.locator('#submitBtn').click();
    await expect(page.locator('#formError')).toContainText('required items');
    const items = page.locator('#checklist').getByRole('button', { name: 'OK', exact: true });
    for (let i = 0; i < await items.count(); i++) await items.nth(i).click();
    await page.locator('#workerList input[name=workers]').first().check();
    await page.locator('#submitBtn').click();
    await expect.poll(() => db().electricalInspection.count({ where: { orgId: x.org.id, locationId: x.locationId, supervisorId: x.supervisor.id } })).toBeGreaterThan(0);
    const record = await db().electricalInspection.findFirst({ where: { orgId: x.org.id, locationId: x.locationId, supervisorId: x.supervisor.id }, orderBy: { createdAt: 'desc' } });

    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await signIn(admin, 'admin', x.admin, slug);
    await admin.goto(orgPage(slug, 'admin-electrical'));
    admin.once('dialog', (d) => d.accept('Readings look copied'));
    await admin.locator('tbody tr').first().getByRole('button', { name: 'View' }).click();
    await admin.locator('#flagBtn').click();
    await expect.poll(async () => (await db().electricalInspection.findUnique({ where: { id: record.id } })).status).toBe('FLAGGED');
    await ctx.close();
  });

  test('BUG-0023: super-admin: a taken slug is refused; create an org, rename it, switch a module on, enter it, delete it', async ({ page }) => {
    await signIn(page, 'superadmin', s.superAdmin);
    await page.goto('/superadmin-dashboard');
    const name = `Form Org ${s.run}`;
    const orgSlug = `form-org-${s.run}`;

    await page.getByRole('button', { name: '+ New Organization' }).click();
    await page.locator('#orgName').fill(name);
    await page.locator('#orgSlug').fill(slug);
    await page.locator('#orgForm button[type=submit]').click();
    await expect(page.locator('#orgError')).toBeVisible();
    await expect(page.locator('#orgError')).not.toBeEmpty();
    // Phone, Email and Address are left empty, as most admins do (BUG-0023).
    await page.locator('#orgSlug').fill(orgSlug);
    await page.locator('#orgForm button[type=submit]').click();
    await expect(page.locator('#orgModal')).toBeHidden();
    const row = page.locator('#orgBody tr', { hasText: name });
    await expect(row).toBeVisible();
    const org = await db().organization.findUnique({ where: { slug: orgSlug } });
    expect(org.enabledModules).toEqual(['ele']);

    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#orgName').fill(`${name} (renamed)`);
    await page.locator('#orgForm button[type=submit]').click();
    await expect.poll(async () => (await db().organization.findUnique({ where: { id: org.id } })).name).toBe(`${name} (renamed)`);
    await page.reload();
    await expect(page.locator('#orgBody tr', { hasText: `${name} (renamed)` })).toBeVisible();

    await page.locator('.sa-tab[data-tab="control-center"]').click();
    await page.locator('#ccOrgFilter').selectOption(org.id);
    await page.locator('#ccModuleGrid input[value="asset"]').check();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => (await db().organization.findUnique({ where: { id: org.id } })).enabledModules.sort()).toEqual(['asset', 'ele']);

    await page.locator('.sa-tab[data-tab="orgs"]').click();
    await page.locator('#orgBody tr', { hasText: `${name} (renamed)` }).getByRole('button', { name: 'Enter' }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/ele/admin-dashboard`));
    await expect(page.getByText('Organization not found')).toHaveCount(0);

    await page.goto('/superadmin-dashboard');
    await page.locator('#orgBody tr', { hasText: `${name} (renamed)` }).getByRole('button', { name: 'Delete' }).click();
    await confirmYes(page);
    await expect.poll(async () => (await db().organization.findUnique({ where: { id: org.id } }))?.status ?? 'GONE').not.toBe('ACTIVE');
  });

  test('BUG-0028: names with quotes, backslashes or markup render as text — no injected attribute or handler code runs', async ({ page, request }) => {
    const { token } = await apiLogin(request, x.admin);
    const headers = { authorization: `Bearer ${token}` };
    const locName = `Loc28 ${s.run}" data-bug0028="1`;
    const empId = `XSS-${s.run}`;
    const elecName = `Elec28 ${s.run}\\');window.__bug0028=1;//`;
    expect((await request.post('/api/locations', { headers, data: { name: locName, type: 'ROOM' } })).ok()).toBeTruthy();
    expect((await request.post('/api/workers', { headers, data: { name: elecName, employeeId: empId } })).ok()).toBeTruthy();
    try {
      await signIn(page, 'admin', x.admin, slug);
      await page.goto(orgPage(slug, 'admin-locations'));
      await expect(page.getByText(locName).first()).toBeVisible();
      await expect(page.locator('[data-bug0028]')).toHaveCount(0);

      await page.goto(orgPage(slug, 'admin-workers'));
      await page.locator('#workerBody tr', { hasText: empId }).getByRole('button', { name: 'Locations' }).click();
      await expect(page.locator('#floorTitle')).toHaveText(`Assign Floors — ${elecName}`);
      expect(await page.evaluate(() => window.__bug0028)).toBeUndefined();
    } finally {
      await db().worker.deleteMany({ where: { employeeId: empId } });
      await db().location.deleteMany({ where: { orgId: x.org.id, name: locName } });
    }
  });
});
