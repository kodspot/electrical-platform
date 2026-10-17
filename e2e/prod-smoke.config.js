'use strict';

/**
 * Playwright configuration for the PRODUCTION smoke (tests-prod/, ADR 0009).
 *
 * Read-only and anonymous: no sign-in, no form post, no upload. Every browser request goes
 * through a route guard that lets only GET and HEAD through (tests-prod/prod-smoke.spec.js),
 * and direct HTTP checks can only send GET or HEAD. Unlike playwright.config.js there is no
 * webServer, no database and no seed: it points at a running deployment.
 *
 *   PROD_SMOKE_URL       the deployment's base URL (https://…; the workflow passes APP_URL)
 *   PROD_SMOKE_ORG_SLUG  the organization whose public and login pages are checked
 *
 * Run: npx playwright test -c prod-smoke.config.js   (from e2e/)
 */

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = (process.env.PROD_SMOKE_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(BASE_URL)) {
  throw new Error('[prod-smoke] PROD_SMOKE_URL must be a base URL such as https://example.com (no path)');
}
if (!/^[a-z0-9-]+$/.test(process.env.PROD_SMOKE_ORG_SLUG || '')) {
  throw new Error('[prod-smoke] PROD_SMOKE_ORG_SLUG must be set to an organization slug (lowercase letters, digits, hyphens)');
}

module.exports = defineConfig({
  testDir: './tests-prod',
  outputDir: './test-results-prod',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // One retry absorbs a network blip between the runner and production.
  retries: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/prod-smoke-results.json' }]
  ],
  use: {
    baseURL: BASE_URL,
    // No traces or videos: the artifacts of this public repository are world-readable.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    // No service worker: every request the page makes then passes the method guard.
    serviceWorkers: 'block'
  },
  projects: [{ name: 'prod-desktop', use: { ...devices['Desktop Chrome'] } }]
});
