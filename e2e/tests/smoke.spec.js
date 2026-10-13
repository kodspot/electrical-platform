'use strict';

// Environment smoke: the app started by webServer is healthy, the per-run seed exists, and
// an org's login page renders. If this fails, nothing else in the suite is meaningful.

const { test, expect } = require('@playwright/test');
const { seed, db } = require('../support/app');

test('the app is up and the per-run seed is in the e2e database', async ({ request }) => {
  const ready = await request.get('/health/ready');
  expect(ready.status()).toBe(200);
  const s = seed();
  const org = await db().organization.findUnique({ where: { id: s.orgA.id } });
  expect(org && org.slug).toBe(s.orgA.slug);
});

test('an organization\'s admin sign-in page renders', async ({ page }) => {
  const s = seed();
  await page.goto(`/${s.orgA.slug}/ele/admin-login`);
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#email')).toBeVisible();
});
