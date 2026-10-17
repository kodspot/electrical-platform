'use strict';

// Production smoke (ADR 0009): after every deploy and nightly, check the live site the way an
// anonymous visitor sees it. READ-ONLY: no sign-in, no form post, no upload.
//
// The read-only rule is enforced, not just intended:
//   - every browser request passes context.route('**/*'): GET and HEAD continue, anything
//     else is aborted, recorded and fails the test;
//   - direct HTTP checks go through `http`, which can only send GET or HEAD;
//   - every request's method is counted and recorded as a `methods` annotation, so the
//     report proves what was sent (scripts/prod-smoke-summary.js).

const { test, expect } = require('@playwright/test');

const SLUG = process.env.PROD_SMOKE_ORG_SLUG;
const PAGES = [
  ['home', '/'],
  ['org home', `/${SLUG}`],
  ['module home', `/${SLUG}/ele`],
  ['admin login', `/${SLUG}/ele/admin-login`],
  ['supervisor login', `/${SLUG}/ele/supervisor-login`],
  ['electrician login', `/${SLUG}/ele/electrician-login`],
  ['super-admin login', '/superadmin-login'],
  ['privacy', '/privacy'],
  ['terms', '/terms'],
  ['reset password (no token)', '/reset-password'],
  ['reset PIN (no token)', '/worker-reset-pin']
];
const READ_ONLY = new Set(['GET', 'HEAD']);

test.describe.configure({ mode: 'serial' });

let methods;
let blocked;
let http;
test.beforeEach(async ({ context, request }) => {
  methods = {};
  blocked = [];
  const count = (m) => { methods[m] = (methods[m] || 0) + 1; };
  await context.route('**/*', (route) => {
    const m = route.request().method();
    count(m);
    if (!READ_ONLY.has(m)) {
      blocked.push(`${m} ${new URL(route.request().url()).pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  // Direct checks: GET and HEAD only, by construction.
  http = {
    get: (url, opts) => { count('GET'); return request.get(url, opts); },
    head: (url, opts) => { count('HEAD'); return request.head(url, opts); }
  };
});
test.afterEach(async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'methods', description: JSON.stringify(methods) });
  expect(blocked, 'the smoke tried to send a request that is not GET/HEAD (blocked)').toEqual([]);
});

test('production is ready (/health/ready)', async () => {
  // A deploy restarts the containers; give the app up to two minutes to come back.
  await expect.poll(async () => {
    const r = await http.get('/health/ready', { failOnStatusCode: false }).catch(() => null);
    return r ? r.status() : 0;
  }, { timeout: 120_000, intervals: [2_000, 5_000] }).toBe(200);
  const body = await (await http.get('/health/ready')).json();
  expect(body.status).toBe('ok');
  expect(body.database).toBe('connected');
});

for (const [name, url] of PAGES) {
  test(`page: ${name} answers 200 and renders cleanly`, async ({ page, baseURL }) => {
    const origin = new URL(baseURL).origin;
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => problems.push(`uncaught: ${(e.message || '(empty)').slice(0, 200)}`));
    page.on('response', (r) => { if (new URL(r.url()).origin === origin && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    page.on('requestfailed', (r) => {
      const err = (r.failure() && r.failure().errorText) || 'failed';
      if (new URL(r.url()).origin === origin && err !== 'net::ERR_ABORTED') problems.push(`failed ${new URL(r.url()).pathname}: ${err}`);
    });

    const resp = await page.goto(url);
    expect(resp && resp.status(), `${url} status`).toBe(200);
    await page.waitForLoadState('load');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    expect(problems, `problems on ${url}`).toEqual([]);
  });
}

test('static assets linked from the pages answer 200', async ({ page }) => {
  const assets = new Set();
  for (const [, url] of PAGES.slice(0, 4)) {
    await page.goto(url);
    for (const a of await page.evaluate(() => [
      ...[...document.querySelectorAll('link[href]')].map((l) => l.getAttribute('href')),
      ...[...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))
    ])) if (a && a.startsWith('/') && !a.startsWith('//')) assets.add(a);
  }
  expect(assets.size).toBeGreaterThan(3);
  const bad = [];
  for (const a of assets) {
    const r = await http.get(a, { failOnStatusCode: false });
    if (r.status() !== 200) bad.push(`${a} → ${r.status()}`);
  }
  expect(bad).toEqual([]);
});

test('security headers are present', async () => {
  const r = await http.get('/');
  const h = r.headers();
  expect(h['strict-transport-security'], 'HSTS').toMatch(/max-age=\d+/);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy'], 'CSP').toContain("default-src 'self'");
  expect(h['x-frame-options'] || (h['content-security-policy'].match(/frame-ancestors [^;]+/) || [''])[0], 'framing protection').toBeTruthy();
  expect(h['referrer-policy']).toBeTruthy();
});

test('plain http redirects to https', async ({ baseURL }) => {
  const u = new URL(baseURL);
  test.skip(u.protocol !== 'https:', 'the target is not served over https');
  const r = await http.get(`http://${u.host}/`, { maxRedirects: 0, failOnStatusCode: false });
  expect([301, 302, 307, 308]).toContain(r.status());
  expect(r.headers()['location']).toMatch(new RegExp(`^https://${u.host.replace(/\./g, '\\.')}/`));
});
