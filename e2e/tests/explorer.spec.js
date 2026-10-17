'use strict';

// The explorer: an automated manual tester, in both projects (desktop + Pixel 7).
//
// For every role (guest, admin, supervisor, electrician, superadmin) it opens every page that
// role may open, on the explorer org (global-setup.js: assets module on, fixtures for the QR,
// review and asset pages), waits for the page's auth/module sync, then follows every in-app
// link on it, one hop, and clicks its [role=tab] controls. Links and tabs only: it never
// clicks a button, so it never submits, deletes or logs out.
//
// Checks on every page and every followed link:
//   document   the page answers 200
//   landed     a signed-in role does not end up on a login page
//   sync       the auth/module sync finished (localStorage.enabledModules, as in BUG-0010)
//   loading    no skeleton, spinner or "Loading…" stays on screen
//   requests   no same-origin request answers ≥ 400 or fails
//   console    no console error, no uncaught exception
//   errorText  no "not found" / "Route GET:… not found" text
//   images     no broken <img>
//   slug       no link carries the org slug twice (BUG-0010)
//   overflow   phone only: no horizontal scroll
//   axe        no critical accessibility violation (pages opened directly)
//   rawValue   no visible "undefined" or "NaN" (a field the page reads but never gets; BUG-0012)
//   nav        admin pages: the admin nav is there (≥ 5 links) and, on desktop, no two links
//              touch on one line (an unstyled nav; BUG-0013)
// And a forbidden matrix: each role opening another role's pages lands on a login page (or,
// for the super-admin on admin pages, its own dashboard) — never on the page.
//
// Pre-existing findings are listed in explorer-allowlist.json (report, don't fail); anything
// else fails. Every visit is recorded as an `explorer` annotation for scripts/summarize.js.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { seed, signIn, signInElectrician } = require('../support/app');
const { settle } = require('../support/visual');
const { ROLES, pages, unreachableFiles, allowlist, redact } = require('../support/explorer');

// Titles come from page names only (the seed does not exist yet when tests are listed).
const NAMES = pages({ slug: 'org', qrCode: 'QR', locationId: 'LOC', reviewToken: 'TOKEN' });
const SYNCED = new Set(['admin', 'supervisor', 'electrician']);

// Links already followed, per project and role: each target is visited once (one hop).
const followed = new Set();

const EMPTY_THROW = 'uncaught: (empty value thrown)';
const scrub = (s) => String(s).replace(/(token=)[^&\s"']+/gi, '$1…').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').slice(0, 240);

async function signInAs(page, role, s) {
  const fx = s.explorer;
  if (role === 'admin') await signIn(page, 'admin', fx.admin, fx.org.slug);
  else if (role === 'supervisor') await signIn(page, 'supervisor', fx.supervisor, fx.org.slug);
  else if (role === 'electrician') await signInElectrician(page, fx.worker, fx.org.slug);
  else if (role === 'superadmin') await signIn(page, 'superadmin', s.superAdmin);
  // Every load starts unsynced, so "synced" is observable (the BUG-0010 technique).
  if (SYNCED.has(role)) await page.addInitScript(() => localStorage.removeItem('enabledModules'));
}

/** Collect same-origin request failures, console errors and uncaught exceptions. */
function listen(page, origin) {
  const buf = { requests: [], console: [] };
  const same = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };
  page.on('response', (r) => {
    if (same(r.url()) && r.status() >= 400) buf.requests.push(`${r.request().method()} ${redact(r.url())} → ${r.status()}`);
  });
  page.on('requestfailed', (r) => {
    const err = (r.failure() && r.failure().errorText) || 'failed';
    // A navigation cancels what the previous page still had in flight (the SSE stream, …).
    if (same(r.url()) && err !== 'net::ERR_ABORTED') buf.requests.push(`${r.request().method()} ${redact(r.url())} ✗ ${err}`);
  });
  page.on('console', (m) => {
    // "Failed to load resource" duplicates a ≥ 400 response, which `requests` already records.
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) buf.console.push(scrub(m.text()));
  });
  page.on('pageerror', (e) => {
    const at = ((e.stack || '').split('\n').find((l) => /^\s+at /.test(l)) || '').trim();
    buf.console.push(e.message || at ? `uncaught: ${scrub(e.message || e.name)}${at ? ` ${scrub(at)}` : ''}` : EMPTY_THROW);
  });
  buf.reset = () => { buf.requests.length = 0; buf.console.length = 0; };
  return buf;
}

/** The page name a path belongs to (for reporting and the allow-list). */
function nameOf(all, pathname) {
  const hit = all.find((p) => new URL(p.url, 'http://x').pathname === pathname);
  return hit ? hit.name : pathname.split('/').filter(Boolean).pop() || 'index';
}

/**
 * Open a URL as the current role and run the checks. Returns { name, failed: [{check, detail}] }.
 */
async function visit(page, buf, ctx, url, { axe }) {
  buf.reset();
  const failed = [];
  const fail = (check, detail) => failed.push({ check, detail: scrub(detail) });
  const target = new URL(url, ctx.origin);
  const resp = await page.goto(url).catch((e) => { fail('document', e.message.split('\n')[0]); return null; });
  if (resp && resp.status() !== 200) fail('document', `${redact(url)} → ${resp.status()}`);
  await page.waitForLoadState('load').catch(() => {});
  const landed = new URL(page.url());
  const name = nameOf(ctx.all, landed.pathname);
  if (/-login$/.test(landed.pathname) && !/-login$/.test(target.pathname)) fail('landed', `${redact(url)} → ${redact(page.url())}`);

  if (SYNCED.has(ctx.role) && ctx.roleOf(name) === ctx.role) {
    await expect.poll(() => page.evaluate(() => localStorage.getItem('enabledModules')), { timeout: 10_000 }).not.toBeNull()
      .catch(() => fail('sync', `${name}: the module sync did not finish`));
  }
  await settle(page).catch(() => fail('loading', `${name}: a skeleton, spinner or "Loading…" stayed on screen`));

  const adminPage = ctx.role === 'admin' && ctx.roleOf(name) === 'admin';
  const facts = await page.evaluate(({ slug, adminPage }) => {
    const text = document.body ? document.body.innerText : '';
    const raw = text.match(/[^\n]{0,30}\b(undefined|NaN)\b[^\n]{0,30}/);
    let nav = null;
    if (adminPage) {
      const links = [...document.querySelectorAll('#topbar-nav a')];
      // The extent of each link's TEXT (padding excluded): on a styled nav neighbouring texts are
      // well apart; on an unstyled one they run together ("DashboardAnalyticsLocations").
      const texts = links.map((a) => { const r = document.createRange(); r.selectNodeContents(a); return r.getBoundingClientRect(); })
        .filter((r) => r.width > 0);
      let touching = 0;
      for (let i = 1; i < texts.length; i++) {
        const a = texts[i - 1], b = texts[i];
        if (Math.abs(a.top - b.top) < 4 && b.left - a.right < 4) touching++;
      }
      nav = { links: links.length, touching };
    }
    const m = text.match(/[^\n]{0,40}\b(not found|Route (GET|POST|PUT|PATCH|DELETE):)[^\n]{0,40}/i);
    const broken = [...document.images].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.src);
    const doubled = [...document.querySelectorAll('a[href]')].map((a) => a.href)
      .filter((h) => { try { return new URL(h).pathname.split(`/${slug}/`).length > 2; } catch { return false; } });
    const el = document.documentElement;
    return { notFound: m ? m[0] : null, raw: raw ? raw[0] : null, nav, broken, doubled, overflow: el.scrollWidth - el.clientWidth };
  }, { slug: ctx.slug, adminPage });
  if (facts.notFound) fail('errorText', facts.notFound);
  if (facts.raw) fail('rawValue', facts.raw);
  if (facts.nav && facts.nav.links < 5) fail('nav', `${name}: the admin nav has ${facts.nav.links} link(s)`);
  if (facts.nav && !ctx.phone && facts.nav.touching) fail('nav', `${name}: ${facts.nav.touching} pair(s) of nav links touch (unstyled nav)`);
  for (const src of facts.broken) fail('images', redact(src));
  if (facts.doubled.length) fail('slug', `${facts.doubled.length} link(s), e.g. ${redact(facts.doubled[0])}`);
  if (ctx.phone && facts.overflow > 1) fail('overflow', `${name}: ${facts.overflow}px wider than the viewport`);
  // Before axe: axe-core fetches cross-origin stylesheets itself, which the app's CSP
  // (connect-src 'self') rightly blocks — that console error is the tool's, not the page's.
  for (const r of buf.requests) fail('requests', r);
  // The pages stop their own script after sending the browser elsewhere with
  // `location.href = …; throw ''` (24 pages). That empty throw is expected when this visit
  // was redirected; anywhere else it is reported.
  const redirected = landed.pathname !== target.pathname;
  for (const c of buf.console) if (!(redirected && c === EMPTY_THROW)) fail('console', c);
  if (axe) {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const critical = r.violations.filter((v) => v.impact === 'critical');
    if (critical.length) fail('axe', critical.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
    buf.reset();
  }
  return { name, failed };
}

/** Visible in-app links (a collapsed phone nav still counts: the menu reveals it). */
async function linksOn(page) {
  return page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => {
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw) || a.hasAttribute('download')) return false;
    if (getComputedStyle(a).display === 'none') return false;
    return a.getClientRects().length > 0 || !!a.closest('nav, #topbar-nav, #sv-nav, .topbar-nav, .sv-nav');
  }).map((a) => a.href));
}

/** Match a finding against the allow-list. */
function allowedBy(entries, role, page, f) {
  return entries.find((e) => (e.role === '*' || e.role === role) && (e.page === '*' || e.page === page) && e.check === f.check && (!e.match || f.detail.includes(e.match)));
}

test.describe('explorer', () => {
  // Independent tests: lets the CI shards (e2e.yml) split this file. workers stays 1.
  test.describe.configure({ mode: 'parallel' });

  test('every public/*.html page is reachable through the route table', () => {
    expect(unreachableFiles(NAMES), 'pages no route serves (add them to pages.js MODULE_PAGES/STATIC_PAGES)').toEqual([]);
  });

  for (const role of ROLES) {
    for (const { name: pageName } of NAMES.filter((p) => p.role === role)) {
      test(`${role} › ${pageName}: opens cleanly, and every link on it works`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        const s = seed();
        const all = pages({ ...s.explorer, slug: s.explorer.org.slug });
        const entry = all.find((p) => p.name === pageName);
        const origin = new URL(testInfo.project.use.baseURL).origin;
        const ctx = { all, role, origin, slug: s.explorer.org.slug, phone: testInfo.project.name === 'chromium-mobile', roleOf: (n) => (all.find((p) => p.name === n) || {}).role };
        const entries = allowlist();
        const unexpected = [];
        const record = (kind, from, res) => {
          const allowed = [];
          for (const f of res.failed) {
            const hit = allowedBy(entries, role, res.name, f);
            if (hit) allowed.push({ check: f.check, finding: hit.finding });
            else unexpected.push(`${kind} ${res.name}${from ? ` (from ${from})` : ''}: ${f.check} — ${f.detail}`);
          }
          testInfo.annotations.push({
            type: 'explorer',
            description: JSON.stringify({ role, page: res.name, kind, from, failed: [...new Set(res.failed.filter((f) => !allowedBy(entries, role, res.name, f)).map((f) => f.check))], allowed })
          });
        };

        await signInAs(page, role, s);
        const buf = listen(page, origin);
        const opened = await visit(page, buf, ctx, entry.url, { axe: true });
        record('open', null, opened);

        // Tabs, in place: click each and check nothing broke.
        const tabs = page.getByRole('tab');
        for (let i = 0; i < await tabs.count(); i++) {
          if (!(await tabs.nth(i).isVisible())) continue;
          const label = ((await tabs.nth(i).textContent()) || `tab ${i + 1}`).trim().slice(0, 40);
          buf.reset();
          await tabs.nth(i).click();
          await settle(page).catch(() => {});
          const failed = [...buf.requests.map((d) => ({ check: 'requests', detail: d })), ...buf.console.map((d) => ({ check: 'console', detail: d }))];
          record('tab', label, { name: opened.name, failed });
        }

        // Links, one hop: each target once per project and role.
        const here = new URL(page.url());
        for (const href of await linksOn(page)) {
          const u = new URL(href);
          if (u.origin !== origin || /logout/i.test(u.pathname)) continue;
          if (u.pathname === here.pathname && u.search === here.search) continue;
          const key = `${testInfo.project.name}|${role}|${u.pathname}${u.search}`;
          if (followed.has(key)) continue;
          followed.add(key);
          if (u.pathname.startsWith('/api/')) {
            // A download/API link: a click sends a plain GET without the bearer token.
            const r = await page.request.get(href);
            record('link', opened.name, { name: redact(href), failed: r.status() >= 400 ? [{ check: 'document', detail: `${redact(href)} → ${r.status()}` }] : [] });
            continue;
          }
          record('link', opened.name, await visit(page, buf, ctx, href, { axe: false }));
        }

        expect(unexpected, `explorer findings (not in explorer-allowlist.json):\n  ${unexpected.join('\n  ')}`).toEqual([]);
      });
    }

    test(`${role} › forbidden pages are never shown`, async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      const s = seed();
      const all = pages({ ...s.explorer, slug: s.explorer.org.slug });
      // Where a role is sent is decided in the browser from localStorage; the API is not
      // needed, and blocking it keeps ~100 login-page loads off the per-address rate limits.
      await page.route('**/api/**', (r) => r.abort());
      await signInAs(page, role, s);
      const shown = [];
      for (const p of all.filter((x) => x.role !== 'guest' && x.role !== role)) {
        const want = new URL(p.url, 'http://x').pathname;
        const resp = await page.goto(p.url);
        if (resp && resp.status() === 404) continue;
        await page.waitForURL((u) => u.pathname !== want, { timeout: 10_000 }).catch(() => {});
        const landed = new URL(page.url()).pathname;
        const ok = landed !== want && (/-login$/.test(landed) || (role === 'superadmin' && landed === '/superadmin-dashboard'));
        if (!ok) shown.push(`${p.name} → ${landed}`);
        testInfo.annotations.push({ type: 'explorer', description: JSON.stringify({ role, page: p.name, kind: 'forbidden', failed: ok ? [] : ['forbidden'], allowed: [] }) });
      }
      expect(shown, `${role} was shown pages it may not open`).toEqual([]);
    });
  }
});
