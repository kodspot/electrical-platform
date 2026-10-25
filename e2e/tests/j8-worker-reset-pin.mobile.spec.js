'use strict';

// J8 — an electrician resets a forgotten PIN from the emailed link, on a phone (F12).
// Runs only in the chromium-mobile project (*.mobile.spec.js; see playwright.config.js).
// Email delivery is off in the e2e app (SES credentials blanked), and the database holds only
// the token's hash (BUG-0034), so the test puts in place a token it knows, stored the way the
// forgot flow stores one, and opens the link with it.

const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { seed, db, apiLogin, orgPage } = require('../support/app');

const factories = () => require(path.join(__dirname, '..', '..', 'apps', 'api', 'scenarios', 'factories'));
const { hashResetToken } = require(path.join(__dirname, '..', '..', 'apps', 'api', 'src', 'lib', 'security'));

test('J8 — an electrician opens the PIN reset link on a phone, sets a new 6-digit PIN and signs in with it', async ({ page }) => {
  const s = seed();
  // A dedicated worker, so no other journey's seeded PIN changes.
  const employeeId = `E2E-J8-${s.run}`.toUpperCase();
  const worker = await factories().createTestWorker(s.orgA.id, {
    pin: String(crypto.randomInt(100000, 999999)), name: `E2E J8 Elec ${s.run}`, employeeId
  });

  // The reset email needs an email on file: the admin adds it through the app.
  const { token: adminToken } = await apiLogin(page.request, s.adminA);
  const patch = await page.request.patch(`/api/workers/${worker.id}`, {
    headers: { authorization: `Bearer ${adminToken}` },
    data: { email: `e2e-j8-${s.run}@example.test` }
  });
  expect(patch.status(), await patch.text()).toBe(200);

  // "Forgot PIN" — the request side always answers the same generic message.
  const forgot = await page.request.post('/api/auth/worker-forgot-pin', { data: { orgSlug: s.orgA.slug, employeeId } });
  expect(forgot.status()).toBe(200);
  await expect.poll(async () => (await db().worker.findUnique({ where: { id: worker.id }, select: { resetToken: true } })).resetToken)
    .toMatch(/^[0-9a-f]{64}$/);
  // Only the token's hash is stored (BUG-0034), so the database cannot give back the link the
  // email carried: replace the stored hash with one of a token this test holds, as the forgot
  // flow would have stored it.
  const resetToken = crypto.randomBytes(32).toString('hex');
  await db().worker.update({ where: { id: worker.id }, data: { resetToken: hashResetToken(resetToken) } });

  // Open the emailed link.
  await page.goto(`/worker-reset-pin?token=${resetToken}`);
  await expect(page.locator('#newPin')).toBeVisible();
  // The token is read once and removed from the address bar (history, bookmarks, Referer).
  expect(page.url()).not.toContain(resetToken);
  await expect(page).toHaveURL(/\/worker-reset-pin$/);

  const newPin = String(crypto.randomInt(100000, 999999));
  await page.locator('#newPin').fill(newPin);
  await page.locator('#confirmPin').fill(newPin);
  await page.locator('#btn').click();

  await expect(page.getByTestId('reset-done')).toContainText('Your PIN has been changed');
  expect(page.url()).not.toContain(resetToken);
  const after = await db().worker.findUnique({ where: { id: worker.id }, select: { resetToken: true, resetTokenExpiresAt: true } });
  expect(after.resetToken).toBeNull();
  expect(after.resetTokenExpiresAt).toBeNull();

  // The success link goes to this org's electrician sign-in; the new PIN works there.
  await page.getByTestId('reset-login-link').click();
  await expect(page).toHaveURL(new RegExp(`${orgPage(s.orgA.slug, 'electrician-login')}$`));
  await page.locator('#employeeId').fill(employeeId);
  await page.locator('#pin').fill(newPin);
  await page.locator('#btn').click();
  await page.waitForURL(/electrician-scan/);

  // The same link cannot be used twice.
  await page.goto(`/worker-reset-pin?token=${resetToken}`);
  await page.locator('#newPin').fill(newPin);
  await page.locator('#confirmPin').fill(newPin);
  await page.locator('#btn').click();
  await expect(page.getByTestId('reset-error')).toContainText(/expired|already been used/);
});
