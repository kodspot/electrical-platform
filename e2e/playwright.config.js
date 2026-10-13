'use strict';

/**
 * Playwright configuration for the browser end-to-end suite (ADR 0006).
 *
 * The app under test is started by `webServer` (scripts/serve-app.js) on port 3100, with
 * STORAGE_DRIVER=local, outbound SES/alert/AI credentials blanked and generated placeholder
 * secrets. Its DATABASE_URL must be a loopback database whose name ends in `_e2e` — enforced
 * here, in serve-app.js and in global-setup.js through apps/api/test/setup/safety-rules.js.
 *
 * `npm run e2e` (repository root) provides that database: a disposable postgres:15-alpine
 * container on 127.0.0.1:55433, removed when the run ends.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { defineConfig, devices } = require('@playwright/test');
const { assertE2eDatabase } = require('./support/safety');

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = process.env.CI === 'true';

assertE2eDatabase(process.env);

// Placeholder secrets generated per run — never a real credential (traces from this public
// repository are downloadable). Fixed across the config's own re-evaluations via the env.
const secret = (name, bytes) => {
  if (!process.env[name]) process.env[name] = crypto.randomBytes(bytes).toString('hex');
  return process.env[name];
};

module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['json', { outputFile: 'reports/results.json' }]
  ],
  globalSetup: require.resolve('./global-setup.js'),
  // Baselines are per platform; only Linux baselines (generated in CI) are ever committed.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
      // The journeys are one ordered story; they open their own mobile contexts where a
      // step happens on a phone, so they run once, in the desktop project.
      testIgnore: /journeys\.spec\.js/
    }
  ],
  webServer: {
    command: 'node scripts/serve-app.js',
    url: `${BASE_URL}/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      APP_URL: BASE_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: path.join(os.tmpdir(), `kodspot-e2e-uploads-${process.pid}`),
      JWT_SECRET: secret('JWT_SECRET', 32),
      COOKIE_SECRET: secret('COOKIE_SECRET', 32),
      ADMIN_KEY: secret('ADMIN_KEY', 16),
      DATA_ENCRYPTION_KEY: secret('DATA_ENCRYPTION_KEY', 32),
      R2_ACCOUNT_ID: 'e2e-placeholder',
      R2_ACCESS_KEY_ID: 'e2e-placeholder',
      R2_SECRET_ACCESS_KEY: 'e2e-placeholder',
      R2_BUCKET_NAME: 'e2e-placeholder',
      SES_SMTP_HOST: '', SES_SMTP_USER: '', SES_SMTP_PASS: '', SES_FROM_EMAIL: '',
      ALERT_TELEGRAM_BOT_TOKEN: '', ALERT_TELEGRAM_CHAT_ID: '', ALERT_WEBHOOK_URL: '',
      GLOBAL_AI_API_KEY: '', GLOBAL_AI_PROVIDER: '', GLOBAL_AI_MODEL: '',
      GH_ACTIONS_DISPATCH_TOKEN: '', QA_INGEST_TOKEN: '',
      RATE_LIMIT_MAX: '100000'
    }
  }
});
