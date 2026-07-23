'use strict';

// Regression tests for WP13's two startup-validation additions to
// src/config/env.js:
//   1. JWT_SECRET/COOKIE_SECRET/ADMIN_KEY must meet a minimum length —
//      previously only checked for presence, so a trivially short (and
//      trivially forgeable) value would boot without complaint.
//   2. An unrecognized NODE_ENV value now prints a startup warning, since
//      every real deployment path sets it to exactly 'production' or 'test'
//      and anything else reaching here is almost certainly a typo that would
//      otherwise silently disable production-safe defaults (verbose query
//      logging, permissive CORS).
//
// env.js runs its validation as top-level module-load side effects (and
// calls process.exit() on failure), so it can't be exercised by requiring it
// in-process — the check would only ever run once per process, and a second
// require() is served from Node's module cache. Each case here spawns a
// fresh child Node process with a fully-controlled, hermetic environment
// (independent of the real .env file's actual secret values) and asserts on
// its exit code and stderr output.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..');

// A complete, valid baseline — every REQUIRED_ENV var plus DATA_ENCRYPTION_KEY,
// all well-formed, so each test only needs to override the one field under test.
const VALID_BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(64),
  COOKIE_SECRET: 'b'.repeat(64),
  ADMIN_KEY: 'c'.repeat(32),
  R2_ACCOUNT_ID: 'dummy-account',
  R2_ACCESS_KEY_ID: 'dummy-access-key',
  R2_SECRET_ACCESS_KEY: 'dummy-secret-key',
  R2_BUCKET_NAME: 'dummy-bucket',
  DATA_ENCRYPTION_KEY: 'd'.repeat(64),
  // Pin the storage driver to the production default ('r2') so these hermetic
  // child processes are independent of the developer's real .env. env.js loads
  // the repo-root .env (dotenv), which does not override an already-set var but
  // *does* inject one that's absent — so without this line, a local .env
  // (e.g. .env.dev.example, which sets STORAGE_DRIVER=local) would leak in and
  // flip the default-driver R2-required assertion below.
  STORAGE_DRIVER: 'r2'
};

// A handful of OS-level vars Node itself needs to function on Windows —
// without these the child process can fail to start for reasons unrelated
// to what's being tested.
const OS_PASSTHROUGH = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'windir'];

function runWithEnv(overrides) {
  const env = { ...VALID_BASE_ENV, ...overrides };
  for (const k of OS_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return spawnSync(process.execPath, ['-e', "require('./src/config/env.js'); console.log('BOOT_OK');"], {
    cwd: API_ROOT,
    env,
    encoding: 'utf8'
  });
}

describe('WP13 — env.js secret-strength and NODE_ENV validation', () => {
  it('boots cleanly with a fully valid baseline environment', () => {
    const res = runWithEnv({});
    assert.strictEqual(res.status, 0, `expected clean boot, got stderr: ${res.stderr}`);
    assert.match(res.stdout, /BOOT_OK/);
  });

  it('exits non-zero when JWT_SECRET is too short', () => {
    const res = runWithEnv({ JWT_SECRET: 'short' });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /JWT_SECRET/);
    assert.match(res.stderr, /characters/);
  });

  it('exits non-zero when COOKIE_SECRET is too short', () => {
    const res = runWithEnv({ COOKIE_SECRET: 'short' });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /COOKIE_SECRET/);
  });

  it('exits non-zero when ADMIN_KEY is too short', () => {
    const res = runWithEnv({ ADMIN_KEY: 'short' });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ADMIN_KEY/);
  });

  it('accepts secrets exactly at the minimum length (boundary, not off-by-one)', () => {
    const res = runWithEnv({ JWT_SECRET: 'x'.repeat(32), COOKIE_SECRET: 'y'.repeat(32), ADMIN_KEY: 'z'.repeat(16) });
    assert.strictEqual(res.status, 0, `expected clean boot at the minimum length, got stderr: ${res.stderr}`);
  });

  it('boots cleanly (no warning) with NODE_ENV=production', () => {
    const res = runWithEnv({ NODE_ENV: 'production' });
    assert.strictEqual(res.status, 0);
    assert.doesNotMatch(res.stderr, /NODE_ENV.*not one of/);
  });

  it('boots cleanly (no warning) with NODE_ENV unset — the existing local-dev convention', () => {
    const res = runWithEnv({});
    assert.strictEqual(res.status, 0);
    assert.doesNotMatch(res.stderr, /NODE_ENV.*not one of/);
  });

  it('warns (but still boots) on a typo\'d NODE_ENV like "Production"', () => {
    const res = runWithEnv({ NODE_ENV: 'Production' });
    assert.strictEqual(res.status, 0, 'a typo must warn, not hard-fail startup');
    assert.match(res.stderr, /NODE_ENV="Production" is not one of/);
  });

  // Platform milestone M1: STORAGE_DRIVER=local drops the R2 credentials from the
  // required set, so a developer can boot the app with no cloud account.
  it('boots without any R2 credentials when STORAGE_DRIVER=local', () => {
    const env = { ...VALID_BASE_ENV, STORAGE_DRIVER: 'local' };
    delete env.R2_ACCOUNT_ID;
    delete env.R2_ACCESS_KEY_ID;
    delete env.R2_SECRET_ACCESS_KEY;
    delete env.R2_BUCKET_NAME;
    for (const k of OS_PASSTHROUGH) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    const res = spawnSync(process.execPath, ['-e', "require('./src/config/env.js'); console.log('BOOT_OK');"], {
      cwd: API_ROOT, env, encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, `expected clean boot with local storage and no R2 creds, got stderr: ${res.stderr}`);
    assert.match(res.stdout, /BOOT_OK/);
  });

  it('still requires R2 credentials with the default (r2) storage driver', () => {
    const res = runWithEnv({ R2_BUCKET_NAME: '' });
    assert.notStrictEqual(res.status, 0, 'default driver must still hard-require R2 config');
    assert.match(res.stderr, /R2_BUCKET_NAME/);
  });
});
