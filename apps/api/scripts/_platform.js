'use strict';

/**
 * Shared helpers for the developer platform command scripts (doctor / setup /
 * reset / clean). [platform-M2, per the Developer Platform Specification §2]
 *
 * Deliberately dependency-free (its own minimal .env parser) so it works before
 * `npm ci` has installed anything. Never prints secrets — only hosts, lengths,
 * and booleans.
 */

const path = require('path');
const fs = require('fs');

const API_DIR = path.join(__dirname, '..');          // apps/api
const ROOT_DIR = path.join(API_DIR, '..', '..');     // repo root
const ROOT_ENV = path.join(ROOT_DIR, '.env');

// npm/npx must be spawned with `shell: true` to be cross-platform: on Windows they are
// .cmd shims, which execFileSync refuses to run by bare name (ENOENT) and refuses to run
// as .cmd without a shell (EINVAL, Node 20+). SHELL_SPAWN carries that option; call sites
// merge it into their execFileSync options. Args here are all space-free, so shell
// word-splitting is not a concern.
const NPM = 'npm';
const NPX = 'npx';
const SHELL_SPAWN = { shell: true };

/** Minimal KEY=VALUE .env parser — no interpolation, no dependency. */
function loadRootEnv() {
  const out = {};
  if (!fs.existsSync(ROOT_ENV)) return out;
  for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** host:port from a DATABASE_URL, for SAFE display — never expose the password. */
function dbHostSafe(url) {
  try { const u = new URL(url); return `${u.hostname}:${u.port || '5432'}`; }
  catch { return '(unset or unparseable)'; }
}

function isLocalDb(url) {
  try { return ['127.0.0.1', 'localhost', '::1', ''].includes(new URL(url).hostname); }
  catch { return false; }
}

/**
 * Production-safety guard. Data-mutating dev commands (reset, clean, and — in a
 * later milestone — seed) call this first and refuse to run against anything that
 * isn't clearly local development. This is what makes it impossible for a developer
 * command to reach production data (DPS §2 universal safety contract).
 */
function assertLocalDevOnly(env) {
  const nodeEnv = (env.NODE_ENV || process.env.NODE_ENV || '').toLowerCase();
  const dbUrl = env.DATABASE_URL || process.env.DATABASE_URL || '';
  if (nodeEnv === 'production') {
    console.error('✗ REFUSING to run: NODE_ENV=production. This command only runs against local development.');
    process.exit(2);
  }
  if (!isLocalDb(dbUrl)) {
    console.error(`✗ REFUSING to run: DATABASE_URL points at ${dbHostSafe(dbUrl)}, not localhost.`);
    console.error('  Developer data commands only run against a local database (see .env.dev.example).');
    process.exit(2);
  }
}

module.exports = { API_DIR, ROOT_DIR, ROOT_ENV, NPM, NPX, SHELL_SPAWN, loadRootEnv, dbHostSafe, isLocalDb, assertLocalDevOnly };
