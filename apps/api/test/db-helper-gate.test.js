'use strict';

// QA-1: test/helpers/db.js#isDatabaseAvailable is the gate in front of the database. Each
// case runs in a child process (preloaded with test/setup/safety.js, hermetic environment)
// against a CLOSED loopback port, so no database is ever reached.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'setup', 'safety.js');
const OS_PASSTHROUGH = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'windir'];
const CLOSED_SAFE_URL = 'postgresql://ci:ci@127.0.0.1:55439/electrical_ci';
const UNSAFE_URL = 'postgresql://svcuser:S3cretPassw0rd@prod-db.internal.example:5432/kodspot_prod';

// Runs `body` (which may use `db` = test/helpers/db.js) and prints RESULT=<json> on stdout.
function runGate({ env, before = '', body }) {
  const code = `${before}
const db = require('./test/helpers/db');
(async () => {
  try { const value = await (${body}); console.log('RESULT=' + JSON.stringify({ ok: true, value })); }
  catch (e) { console.log('RESULT=' + JSON.stringify({ ok: false, message: e.message })); }
  process.exit(0);
})();`;
  const full = { NODE_ENV: 'test', DATA_ENCRYPTION_KEY: 'd'.repeat(64), ...env };
  for (const k of OS_PASSTHROUGH) if (process.env[k] !== undefined) full[k] = process.env[k];
  const res = spawnSync(process.execPath, ['--require', PRELOAD, '-e', code], { cwd: API_ROOT, env: full, encoding: 'utf8' });
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT='));
  assert.ok(line, `child produced no result (status ${res.status}): ${res.stderr.slice(0, 500)}`);
  return { result: JSON.parse(line.slice('RESULT='.length)), res };
}

const assertNoLeak = (text) => {
  for (const f of ['svcuser', 'S3cretPassw0rd', 'prod-db.internal.example', 'kodspot_prod']) {
    assert.ok(!text.includes(f), `leaked ${f}`);
  }
};

describe('QA-1 skip gate — isDatabaseAvailable()', () => {
  it('outside CI, an unreachable safe database still resolves false (the file skips)', () => {
    const { result } = runGate({ env: { DATABASE_URL: CLOSED_SAFE_URL }, body: 'db.isDatabaseAvailable(1000)' });
    assert.deepStrictEqual(result, { ok: true, value: false });
  });

  it('with CI=true, an unreachable database throws instead of skipping', () => {
    const { result } = runGate({ env: { DATABASE_URL: CLOSED_SAFE_URL, CI: 'true' }, body: 'db.isDatabaseAvailable(1000)' });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /CI=true: database unreachable/);
  });

  it('throws when DATABASE_URL was changed to an unsafe value after the preload, without printing it', () => {
    const { result, res } = runGate({
      env: { DATABASE_URL: CLOSED_SAFE_URL },
      body: `(process.env.DATABASE_URL = ${JSON.stringify(UNSAFE_URL)}, db.isDatabaseAvailable(1000))`
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /\[test safety\] NON_LOOPBACK_HOST/);
    assertNoLeak(result.message + res.stdout.replace(/prisma:query[^\n]*/g, '') + res.stderr);
  });

  it('judges the URL Prisma captured when db.js first loaded it, even if the variable changed back', () => {
    const { result } = runGate({
      env: { DATABASE_URL: CLOSED_SAFE_URL },
      before: `process.env.DATABASE_URL = ${JSON.stringify(UNSAFE_URL)};`,
      body: `(process.env.DATABASE_URL = ${JSON.stringify(CLOSED_SAFE_URL)}, db.isDatabaseAvailable(1000))`
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /NON_LOOPBACK_HOST/);
    assertNoLeak(result.message);
  });
});
