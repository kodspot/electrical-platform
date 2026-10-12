'use strict';

// QA-1: the test-process safety guard (test/setup/safety-rules.js + the preload
// test/setup/safety.js). In-process cases pin every rule of evaluateTarget(); spawned
// cases prove the preload itself fails closed in a real process, blanks outbound
// credentials before dotenv can inject them, and never prints a value.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateTarget, evaluateEffectiveTarget, OUTBOUND_BLANKED, R2_PLACEHOLDERS } = require('./setup/safety-rules');

const API_ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'setup', 'safety.js');
const OS_PASSTHROUGH = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'windir'];

// Distinctive fragments that must never appear in any refusal message.
const SECRET_USER = 'svcuser';
const SECRET_PASS = 'S3cretPassw0rd';
const SECRET_HOST = 'prod-db.internal.example';
const SECRET_DB = 'kodspot_prod';
const UNSAFE_URL = `postgresql://${SECRET_USER}:${SECRET_PASS}@${SECRET_HOST}:5432/${SECRET_DB}`;
const SAFE_URL = 'postgresql://ci:ci@127.0.0.1:55432/electrical_ci';

const judge = (DATABASE_URL, extra = {}, dotenvText = null) => {
  const env = { NODE_ENV: 'test', ...extra };
  if (DATABASE_URL !== undefined) env.DATABASE_URL = DATABASE_URL;
  return evaluateTarget({ env, dotenvText });
};

function assertNoValueLeak(text) {
  for (const fragment of [SECRET_USER, SECRET_PASS, SECRET_HOST, SECRET_DB]) {
    assert.ok(!text.includes(fragment), `message leaked a value fragment: ${fragment}`);
  }
}

function hermeticEnv(vars) {
  const env = { ...vars };
  for (const k of OS_PASSTHROUGH) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function runPreloaded(code, vars) {
  return spawnSync(process.execPath, ['--require', PRELOAD, '-e', code], {
    cwd: API_ROOT, env: hermeticEnv(vars), encoding: 'utf8'
  });
}

describe('QA-1 safety guard — evaluateTarget rules', () => {
  it('requires NODE_ENV to be exactly "test"', () => {
    for (const NODE_ENV of [undefined, 'production', 'development', 'Test']) {
      const env = { DATABASE_URL: SAFE_URL };
      if (NODE_ENV !== undefined) env.NODE_ENV = NODE_ENV;
      const v = evaluateTarget({ env, dotenvText: null });
      assert.strictEqual(v.ok, false, `NODE_ENV=${NODE_ENV} must be refused`);
      assert.strictEqual(v.code, 'NODE_ENV_NOT_TEST');
    }
  });

  it('accepts loopback hosts with a _ci/_test/_e2e database name', () => {
    for (const url of [
      SAFE_URL,
      'postgresql://u:p@localhost:5432/electrical_test',
      'postgres://u:p@LOCALHOST/electrical_e2e',
      'postgresql://u:p@[::1]:5432/electrical_test',
      'postgresql://u:p@127.0.0.1:5432/electrical_ci?schema=public&connection_limit=5'
    ]) {
      const v = judge(url);
      assert.strictEqual(v.ok, true, `expected ${url} to be accepted, got ${v.code}`);
      assert.strictEqual(v.code, 'SAFE_TARGET');
      assert.strictEqual(v.source, 'ambient');
    }
  });

  it('refuses any non-loopback host', () => {
    for (const host of ['db', '10.0.0.5', '127.0.0.2', 'localhost.evil.example', SECRET_HOST, '0.0.0.0']) {
      const v = judge(`postgresql://${SECRET_USER}:${SECRET_PASS}@${host}:5432/electrical_ci`);
      assert.strictEqual(v.ok, false, `host ${host} must be refused`);
      assert.strictEqual(v.code, 'NON_LOOPBACK_HOST');
      assertNoValueLeak(v.message);
    }
  });

  it('refuses connection-redirecting query parameters, case-insensitively', () => {
    for (const q of ['host=10.0.0.5', 'HostAddr=10.0.0.5', 'port=6543', 'dbname=kodspot_prod', 'SERVICE=prod']) {
      const v = judge(`postgresql://u:p@127.0.0.1:5432/electrical_ci?${q}`);
      assert.strictEqual(v.ok, false, `?${q} must be refused`);
      assert.strictEqual(v.code, 'FORBIDDEN_QUERY_PARAM');
    }
  });

  it('refuses database names that are not plain *_ci / *_test / *_e2e identifiers', () => {
    for (const name of [SECRET_DB, 'electrical', 'electrical_ci_prod', 'electrical-ci', 'electrical%2Fx_ci', '', 'a b_ci']) {
      const v = judge(`postgresql://u:p@127.0.0.1:5432/${name}`);
      assert.strictEqual(v.ok, false, `database name "${name}" must be refused`);
      assert.ok(['BAD_DB_NAME', 'UNPARSEABLE'].includes(v.code), `unexpected code ${v.code} for "${name}"`);
      assertNoValueLeak(v.message);
    }
  });

  it('refuses unparseable values and non-postgres protocols', () => {
    assert.strictEqual(judge('not a url').code, 'UNPARSEABLE');
    assert.strictEqual(judge('postgresql://u:p@127.0.0.1:99999/electrical_ci').code, 'UNPARSEABLE');
    assert.strictEqual(judge('mysql://u:p@127.0.0.1:3306/electrical_ci').code, 'BAD_PROTOCOL');
    assert.strictEqual(judge('prisma://accelerate.example/?api_key=x').code, 'BAD_PROTOCOL');
  });

  it('with CI=true, requires an explicit non-empty ambient DATABASE_URL (never .env)', () => {
    const safeDotenv = `DATABASE_URL=${SAFE_URL}\n`;
    assert.strictEqual(judge(undefined, { CI: 'true' }).code, 'CI_REQUIRES_AMBIENT_URL');
    assert.strictEqual(judge('', { CI: 'true' }).code, 'CI_REQUIRES_AMBIENT_URL');
    assert.strictEqual(judge(undefined, { CI: 'true' }, safeDotenv).code, 'CI_REQUIRES_AMBIENT_URL');
    assert.strictEqual(judge(SAFE_URL, { CI: 'true' }).ok, true);
    assert.strictEqual(judge(UNSAFE_URL, { CI: 'true' }).code, 'NON_LOOPBACK_HOST');
  });

  it('outside CI, judges the repo-root .env value only when no DATABASE_URL key is set', () => {
    const unsafeDotenv = `JWT_SECRET=whatever\nDATABASE_URL=${UNSAFE_URL}\n`;
    const v = judge(undefined, {}, unsafeDotenv);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.source, '.env');
    assert.match(v.message, /repo-root \.env/);
    assertNoValueLeak(v.message);

    assert.strictEqual(judge(undefined, {}, `DATABASE_URL=${SAFE_URL}\n`).source, '.env');
    // A key set to '' blocks dotenv injection, so the .env value can never be used.
    assert.strictEqual(judge('', {}, unsafeDotenv).code, 'NO_TARGET');
  });

  it('outside CI, allows "no database target" (src/config/env.js refuses to boot without one)', () => {
    const v = judge(undefined);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.code, 'NO_TARGET');
  });
});

describe('QA-1 safety guard — post-load re-check (evaluateEffectiveTarget)', () => {
  it('re-accepts a .env-sourced URL the preload accepted, once env.js has injected it', () => {
    const dotenvText = `DATABASE_URL=${SAFE_URL}\n`;
    const env = { NODE_ENV: 'test' };
    const preload = evaluateTarget({ env, dotenvText });
    assert.strictEqual(preload.ok, true);
    assert.strictEqual(preload.source, '.env');

    env.DATABASE_URL = SAFE_URL; // what dotenv in src/config/env.js does next
    const recheck = evaluateEffectiveTarget({ env, dotenvText: null, capturedUrl: undefined });
    assert.strictEqual(recheck.ok, true);
    assert.strictEqual(recheck.code, 'SAFE_TARGET');
  });

  it('refuses when the URL changed to an unsafe value after the preload accepted a .env-sourced one', () => {
    const env = { NODE_ENV: 'test' };
    assert.strictEqual(evaluateTarget({ env, dotenvText: `DATABASE_URL=${SAFE_URL}\n` }).ok, true);
    env.DATABASE_URL = UNSAFE_URL;
    const recheck = evaluateEffectiveTarget({ env, dotenvText: null, capturedUrl: undefined });
    assert.strictEqual(recheck.code, 'NON_LOOPBACK_HOST');
    assertNoValueLeak(recheck.message);
  });

  it('judges the URL Prisma captured at load, not only the current one', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: SAFE_URL };
    assert.strictEqual(evaluateEffectiveTarget({ env, capturedUrl: UNSAFE_URL }).code, 'NON_LOOPBACK_HOST');
    assert.strictEqual(evaluateEffectiveTarget({ env, capturedUrl: 'postgresql://u:p@localhost/other_test' }).ok, true);
    assert.strictEqual(evaluateEffectiveTarget({ env, capturedUrl: SAFE_URL }).ok, true);
  });
});

describe('QA-1 safety guard — preload in a real process', () => {
  it('exits 1 on an unsafe ambient DATABASE_URL, naming the rule but never the value', () => {
    const res = runPreloaded("console.log('SHOULD_NOT_RUN')", { NODE_ENV: 'test', DATABASE_URL: UNSAFE_URL });
    assert.strictEqual(res.status, 1);
    assert.doesNotMatch(res.stdout, /SHOULD_NOT_RUN/);
    assert.match(res.stderr, /\[test safety\] NON_LOOPBACK_HOST/);
    assertNoValueLeak(res.stderr + res.stdout);
  });

  it('exits 1 when NODE_ENV is not "test"', () => {
    const res = runPreloaded("console.log('SHOULD_NOT_RUN')", { NODE_ENV: 'production', DATABASE_URL: SAFE_URL });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /NODE_ENV_NOT_TEST/);
  });

  it('exits 1 under CI=true without an ambient DATABASE_URL', () => {
    const res = runPreloaded("console.log('SHOULD_NOT_RUN')", { NODE_ENV: 'test', CI: 'true' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /CI_REQUIRES_AMBIENT_URL/);
  });

  it('accepts a safe target, blanks outbound credentials, and placeholders R2', () => {
    const vars = { NODE_ENV: 'test', DATABASE_URL: SAFE_URL };
    for (const k of OUTBOUND_BLANKED) vars[k] = `real-looking-${k}`;
    for (const k of R2_PLACEHOLDERS) vars[k] = `real-looking-${k}`;
    const res = runPreloaded(
      'console.log(JSON.stringify({ env: process.env, marker: globalThis.__qaSafetyPreload === process.pid }))',
      vars
    );
    assert.strictEqual(res.status, 0, `expected acceptance, got stderr: ${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.marker, true);
    for (const k of OUTBOUND_BLANKED) assert.strictEqual(out.env[k], '', `${k} must be blanked`);
    for (const k of R2_PLACEHOLDERS) assert.strictEqual(out.env[k], 'test-placeholder', `${k} must be a placeholder`);
  });

  it('keeps a blanked credential blank after dotenv loads a file that sets it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa1-dotenv-'));
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'SES_SMTP_HOST=smtp.should-not-be-used.example\nGLOBAL_AI_API_KEY=sk-should-not-be-used\n');
    try {
      const res = runPreloaded(
        `require('dotenv').config({ path: ${JSON.stringify(envFile)}, quiet: true });` +
        'console.log(JSON.stringify([process.env.SES_SMTP_HOST, process.env.GLOBAL_AI_API_KEY]))',
        { NODE_ENV: 'test', DATABASE_URL: SAFE_URL }
      );
      assert.strictEqual(res.status, 0, res.stderr);
      assert.deepStrictEqual(JSON.parse(res.stdout), ['', '']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows an empty DATABASE_URL outside CI only because env.js then refuses to boot', () => {
    const res = runPreloaded("require('./src/config/env.js'); console.log('BOOT_OK')", {
      NODE_ENV: 'test',
      DATABASE_URL: '',
      JWT_SECRET: 'a'.repeat(64),
      COOKIE_SECRET: 'b'.repeat(64),
      ADMIN_KEY: 'c'.repeat(32),
      DATA_ENCRYPTION_KEY: 'd'.repeat(64)
    });
    assert.notStrictEqual(res.status, 0, 'env.js must refuse to boot without a DATABASE_URL');
    assert.doesNotMatch(res.stdout, /BOOT_OK/);
    assert.match(res.stderr, /Missing required env variable: DATABASE_URL/);
  });

  it('does nothing when executed as a main module (node --test discovery runs every file under test/)', () => {
    const res = spawnSync(process.execPath, [PRELOAD], {
      cwd: API_ROOT, env: hermeticEnv({ DATABASE_URL: UNSAFE_URL }), encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stderr, '');
  });
});
