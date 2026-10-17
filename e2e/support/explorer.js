'use strict';

// The explorer's page list and role map (tests/explorer.spec.js).
//
// Derived from the app's own route table, never hand-typed: apps/api/src/routes/pages.js
// exports MODULE_PAGES (served at /{org}/{mod}/{page}) and STATIC_PAGES (outside an org).
// A new page added there is explored automatically; a public/*.html file that no route
// reaches fails `unreachableFiles()`.
//
// Role by name: admin-* → admin, supervisor-* → supervisor, electrician-* → electrician,
// superadmin-* → superadmin; *-login and everything else is a guest page.

const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const { MODULE_PAGES, STATIC_PAGES } = require(path.join(API_DIR, 'src', 'routes', 'pages'));

// Pages that only show their content for a given location (without one they send the user to
// the scan page, by design).
const CONTEXT = {
  'supervisor-electrical': (fx) => `?locationId=${fx.locationId}`
};

const ROLES = ['guest', 'admin', 'supervisor', 'electrician', 'superadmin'];

function roleOf(name) {
  if (/-login$/.test(name)) return 'guest';
  const m = /^(admin|supervisor|electrician|superadmin)-/.exec(name);
  return m ? m[1] : 'guest';
}

/**
 * Every page of the app, as { name, url, file, role }.
 * @param {{ slug: string, qrCode: string, locationId: string, reviewToken: string }} fx — the explorer org fixtures
 */
function pages(fx) {
  const list = [];
  const params = { ':code': fx.qrCode, ':token': fx.reviewToken };
  const seen = new Set();
  for (const { path: route, file } of STATIC_PAGES) {
    const stem = file.replace(/\.html$/, '');
    const name = route === '/' ? 'index' : seen.has(stem) ? `${stem} (${route})` : stem;
    seen.add(stem);
    list.push({ name, url: route.replace(/:\w+/g, (p) => params[p]), file, role: roleOf(name) });
  }
  // The org and module landing pages (/:orgSlug, /:orgSlug/:mod) and the service worker's
  // offline fallback (a plain static file).
  list.push({ name: 'org-home', url: `/${fx.slug}`, file: 'org-home.html', role: 'guest' });
  list.push({ name: 'module-home', url: `/${fx.slug}/ele`, file: 'module-home.html', role: 'guest' });
  list.push({ name: 'offline', url: '/offline.html', file: 'offline.html', role: 'guest' });
  for (const page of MODULE_PAGES) list.push({ name: page, url: `/${fx.slug}/ele/${page}${CONTEXT[page] ? CONTEXT[page](fx) : ''}`, file: `${page}.html`, role: roleOf(page) });
  return list;
}

/** public/*.html files that no explored page serves (must be empty). */
function unreachableFiles(list) {
  const served = new Set(list.map((p) => p.file));
  return fs.readdirSync(path.join(API_DIR, 'public')).filter((f) => f.endsWith('.html') && !served.has(f));
}

/**
 * Pre-existing findings the explorer reports but does not fail on (explorer-allowlist.json).
 * Each entry: { role, page, check, finding, reason } — role/page may be '*'. The list may only
 * shrink: an entry that no longer reproduces is reported "remove me". BUG-0010 is never listed.
 */
function allowlist() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'explorer-allowlist.json'), 'utf8')).entries;
}

/** Strip query strings and hide id/token-like path segments before anything is recorded. */
function redact(url) {
  let p;
  try { p = new URL(url, 'http://x').pathname; } catch { return '(unparseable)'; }
  return p.replace(/\/[0-9a-f]{32,}(?=\/|$)/gi, '/:token').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id');
}

module.exports = { ROLES, roleOf, pages, unreachableFiles, allowlist, redact };
