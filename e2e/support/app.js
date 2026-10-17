'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jsQR = require('jsqr');
const { expect } = require('@playwright/test');

const SEED_FILE = path.join(__dirname, '..', '.auth', 'seed.json');
const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');

function seed() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

let _prisma;
/** Prisma client (the app's own generated client) for asserting database state. */
function db() {
  if (!_prisma) {
    const { PrismaClient } = require(path.join(API_DIR, 'node_modules', '@prisma', 'client'));
    _prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  }
  return _prisma;
}

// One API login per account per RUN, shared across worker processes (each project gets its
// own worker): the app allows 10 logins per 15 minutes per address, and the suite must stay
// inside the production limit, not loosen it. The cache is keyed by the per-run seed id, so
// a session from an earlier run's database (and secret) is never reused. UI login itself is
// exercised by the journeys and the negative cases.
const SESSIONS_FILE = path.join(__dirname, '..', '.auth', 'sessions.json');
function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
async function apiLogin(request, { email, password }) {
  const key = `${seed().run}:${email}`;
  const cached = readSessions()[key];
  if (cached) return cached;
  const res = await request.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) throw new Error(`login failed (${res.status()})`);
  const body = await res.json();
  const all = readSessions();
  for (const k of Object.keys(all)) if (!k.startsWith(`${seed().run}:`)) delete all[k];
  all[key] = body;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all));
  return body;
}

/** Worker (electrician) PIN login, cached per run like apiLogin (worker-login has its own 10 per 15 minutes). */
async function workerLogin(request, { orgSlug, employeeId, pin }) {
  const key = `${seed().run}:worker:${orgSlug}:${employeeId}`;
  const cached = readSessions()[key];
  if (cached) return cached;
  const res = await request.post('/api/auth/worker-login', { data: { orgSlug, employeeId, pin } });
  if (!res.ok()) throw new Error(`worker login failed (${res.status()})`);
  const body = await res.json();
  const all = readSessions();
  all[key] = body;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all));
  return body;
}

/** Make the next page loads behave as an already-signed-in electrician of orgSlug. */
async function signInElectrician(page, account, orgSlug) {
  const { token, worker } = await workerLogin(page.request, { orgSlug, employeeId: account.employeeId, pin: account.pin });
  await page.addInitScript(({ token, worker, orgSlug }) => {
    localStorage.setItem('elec_token', token);
    localStorage.setItem('elec_user', JSON.stringify(worker || {}));
    localStorage.setItem('orgSlug', orgSlug);
    localStorage.setItem('activeModule', 'ele');
  }, { token, worker, orgSlug });
  return token;
}

/** Make the next page loads behave as an already-signed-in admin/supervisor/super-admin. */
async function signIn(page, kind, account, orgSlug) {
  const { token, user } = await apiLogin(page.request, account);
  await page.addInitScript(({ kind, token, user, orgSlug }) => {
    if (kind === 'admin') {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
    } else if (kind === 'supervisor') {
      localStorage.setItem('sup_token', token);
      localStorage.setItem('sup_user', JSON.stringify({ id: user.id, name: user.name, orgId: user.orgId }));
    } else if (kind === 'superadmin') {
      localStorage.setItem('sa_token', token);
      localStorage.setItem('sa_user', JSON.stringify(user));
    }
    if (orgSlug) localStorage.setItem('orgSlug', orgSlug);
    localStorage.setItem('activeModule', 'ele');
  }, { kind, token, user, orgSlug });
  return token;
}

const orgPage = (slug, page) => `/${slug}/ele/${page}`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Choose an option in a custom-select-enhanced <select> (public/js/custom-select.js), the way
 * a user does: open the trigger, click the option. Exact text by default ("Room" must not pick
 * "Panel Room"); `exact: false` matches a substring, for long hierarchical labels.
 */
async function pickOption(page, selectId, label, { exact = true } = {}) {
  const wrap = page.locator('.cs-wrap', { has: page.locator(`#${selectId}`) });
  await wrap.locator('.cs-trigger').click();
  const text = exact ? new RegExp(`^\\s*${escapeRe(label)}\\s*$`) : label;
  await page.locator(`#cs-list-${selectId} .cs-option`).filter({ hasText: text }).first().click();
  await expect(page.locator(`#${selectId}`)).not.toHaveValue('');
}

/** Encode a solid-colour RGB PNG (the server checks image signatures and re-encodes with sharp). */
function makePng(width, height, [r, g, b]) {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
const PNG = makePng(32, 32, [37, 99, 235]);
const photo = (name = 'photo.png') => ({ name, mimeType: 'image/png', buffer: PNG });

/** Render an SVG QR code in the browser and decode it with jsQR. Returns the encoded text. */
async function decodeQrSvg(page, svg) {
  const { width, height, data } = await page.evaluate(async (markup) => {
    const size = 480;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size);
    return { width: size, height: size, data: Array.from(pixels.data) };
  }, svg);
  const code = jsQR(Uint8ClampedArray.from(data), width, height);
  return code ? code.data : null;
}

module.exports = { seed, db, apiLogin, workerLogin, signIn, signInElectrician, orgPage, pickOption, photo, decodeQrSvg };
