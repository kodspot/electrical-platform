'use strict';

// WP-Q: services/production-checks.js and lib/github.js, with every external dependency
// stubbed (R2, SMTP, GitHub, database) — no network, no database. Asserts the read-only
// checks' statuses and that no secret, host, bucket name or URL reaches any detail.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runProductionChecks } = require('../src/services/production-checks');
const github = require('../src/lib/github');

const SECRET_BUCKET = 'kodspot-secret-backup-bucket';
const SECRET_TOKEN = 'github_pat_SECRETSECRETSECRET1234567890';
const FORBIDDEN = [SECRET_BUCKET, SECRET_TOKEN, 'r2.cloudflarestorage.com', 'https://', 'http://', 'smtp.secret-host.example', 'super-secret-pepper'];
const assertClean = (results) => {
  const text = JSON.stringify(results);
  for (const f of FORBIDDEN) assert.ok(!text.includes(f), `leaked "${f}" in ${text}`);
};

function migrationsDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mig-'));
  for (const n of names) {
    fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, n, 'migration.sql'), '-- x');
  }
  return dir;
}

function fakePrisma(applied) {
  return {
    $queryRaw: async (strings) => (strings.join('').includes('_prisma_migrations') ? applied.map((m) => ({ migration_name: m })) : [{ ok: 1 }])
  };
}

const NOW = Date.parse('2026-10-13T12:00:00Z');

function baseDeps(overrides = {}) {
  return {
    prisma: fakePrisma(['m1', 'm2']),
    migrationsDir: migrationsDir(['m1', 'm2']),
    storageDriver: () => 'r2',
    r2Client: () => ({ send: async () => ({ Contents: [{ LastModified: new Date(NOW - 2 * 3_600_000) }] }) }),
    verifySmtp: async () => ({ configured: true, ok: true }),
    checkDispatchToken: async () => ({ status: 'SKIPPED', detail: 'dispatch token not configured' }),
    sseStats: () => ({ totalOrgs: 2, totalConnections: 5 }),
    env: { R2_BUCKET_NAME: SECRET_BUCKET, IP_HASH_PEPPER: 'super-secret-pepper', GIT_SHA: 'abcdef1234567890', ALERT_WEBHOOK_URL: 'https://alerts.example/x' },
    now: () => NOW,
    uptimeSeconds: () => 42,
    ...overrides
  };
}

const byName = (results, name) => results.find((r) => r.name === name);

describe('WP-Q production checks — statuses', () => {
  it('a healthy platform: database PASS, backups PASS, email PASS, build PASS, config booleans', async () => {
    const streamed = [];
    const results = await runProductionChecks({ deps: baseDeps(), onResult: (r) => streamed.push(r) });
    assert.deepStrictEqual(streamed, results, 'every result is streamed as soon as it is known');
    assert.strictEqual(byName(results, 'database').status, 'PASS');
    assert.strictEqual(byName(results, 'offsite-backups').status, 'PASS');
    assert.match(byName(results, 'offsite-backups').detail, /2 h old/);
    assert.strictEqual(byName(results, 'email').status, 'PASS');
    assert.strictEqual(byName(results, 'build').status, 'PASS');
    assert.match(byName(results, 'build').detail, /abcdef123456/);
    assert.strictEqual(byName(results, 'config: error alerting').status, 'PASS');
    assert.strictEqual(byName(results, 'config: QA ingest token').status, 'WARN');
    assert.strictEqual(byName(results, 'live connections (SSE)').detail, '5 open connection(s) across 2 org(s)');
    for (const r of results) assert.ok(['PASS', 'WARN', 'FAIL', 'SKIPPED'].includes(r.status));
    assertClean(results);
  });

  it('migrations: a shipped migration not applied is FAIL; an unknown applied one is WARN', async () => {
    const missing = await runProductionChecks({ deps: baseDeps({ prisma: fakePrisma(['m1']) }) });
    assert.strictEqual(byName(missing, 'database').status, 'FAIL');
    const extra = await runProductionChecks({ deps: baseDeps({ prisma: fakePrisma(['m1', 'm2', 'm0-hotfix']) }) });
    assert.strictEqual(byName(extra, 'database').status, 'WARN');
  });

  it('offsite backups: age bands, none found, local driver, and an R2 error reported by name only', async () => {
    const age = (h) => () => ({ send: async (cmd) => (cmd.constructor.name === 'HeadBucketCommand' ? {} : { Contents: [{ LastModified: new Date(NOW - h * 3_600_000) }] }) });
    assert.strictEqual(byName(await runProductionChecks({ deps: baseDeps({ r2Client: age(30) }) }), 'offsite-backups').status, 'WARN');
    assert.strictEqual(byName(await runProductionChecks({ deps: baseDeps({ r2Client: age(72) }) }), 'offsite-backups').status, 'FAIL');
    const none = await runProductionChecks({ deps: baseDeps({ r2Client: () => ({ send: async () => ({ Contents: [] }) }) }) });
    assert.match(byName(none, 'offsite-backups').detail, /no offsite backups/);
    const local = await runProductionChecks({ deps: baseDeps({ storageDriver: () => 'local' }) });
    assert.strictEqual(byName(local, 'offsite-backups').status, 'SKIPPED');

    const denied = Object.assign(new Error(`Access Denied for bucket ${SECRET_BUCKET} at https://acct.r2.cloudflarestorage.com`), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    const failed = await runProductionChecks({ deps: baseDeps({ r2Client: () => ({ send: async () => { throw denied; } }) }) });
    assert.strictEqual(byName(failed, 'offsite-backups').detail, 'R2 request failed (AccessDenied, http 403)');
    assertClean(failed);
  });

  it('email: not configured is WARN, a verify failure is FAIL with only the error code', async () => {
    const off = await runProductionChecks({ deps: baseDeps({ verifySmtp: async () => ({ configured: false }) }) });
    assert.strictEqual(byName(off, 'email').status, 'WARN');
    const bad = await runProductionChecks({ deps: baseDeps({ verifySmtp: async () => ({ configured: true, ok: false, code: 'EAUTH' }) }) });
    assert.strictEqual(byName(bad, 'email').detail, 'SMTP verify failed (EAUTH)');
  });

  it('a check that hangs is reported FAIL "timed out" instead of blocking the others', async () => {
    const results = await runProductionChecks({ deps: baseDeps({ timeoutMs: 50, verifySmtp: () => new Promise(() => {}) }) });
    assert.match(byName(results, 'email').detail, /timed out/);
    assert.strictEqual(byName(results, 'build').status, 'PASS', 'later checks still run');
  });
});

describe('WP-Q github — dispatch-token expiry and CI status', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.GH_ACTIONS_DISPATCH_TOKEN = '';
    github._resetCiCacheForTests();
  });

  const respond = (status, headers = {}, body = {}) => async () => new Response(JSON.stringify(body), { status, headers });

  it('expiry: PASS when far, WARN under 14 days, FAIL when expired or 401, "expiry unknown" without the header', async () => {
    process.env.GH_ACTIONS_DISPATCH_TOKEN = SECRET_TOKEN;
    const now = NOW;
    const at = (days) => new Date(now + days * 86_400_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    globalThis.fetch = respond(200, { 'github-authentication-token-expiration': at(60) });
    assert.strictEqual((await github.checkDispatchToken({ now })).status, 'PASS');
    globalThis.fetch = respond(200, { 'github-authentication-token-expiration': at(5) });
    const soon = await github.checkDispatchToken({ now });
    assert.strictEqual(soon.status, 'WARN');
    assert.match(soon.detail, /expires in 5 day/);
    globalThis.fetch = respond(200, { 'github-authentication-token-expiration': at(-1) });
    assert.strictEqual((await github.checkDispatchToken({ now })).status, 'FAIL');
    globalThis.fetch = respond(200, { 'github-authentication-token-expiration': '2026-12-31 23:59:59 +0000' });
    assert.strictEqual((await github.checkDispatchToken({ now })).status, 'PASS');
    globalThis.fetch = respond(401);
    assert.match((await github.checkDispatchToken({ now })).detail, /401/);
    globalThis.fetch = respond(200);
    assert.strictEqual((await github.checkDispatchToken({ now })).detail, 'token accepted; expiry unknown');
  });

  it('expiry: SKIPPED when no token is configured, without any request', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}'); };
    assert.strictEqual((await github.checkDispatchToken()).status, 'SKIPPED');
    assert.strictEqual(called, false);
  });

  it('ci-status: whitelisted fields only, cached for 60 s, versioned headers, token only when set', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ workflow_runs: [{
        id: 1, name: 'Deploy', head_branch: 'batch-1', event: 'pull_request', status: 'completed', conclusion: 'success',
        created_at: 'c', updated_at: 'u', html_url: 'https://github.com/x/actions/runs/1', head_sha: 'abc',
        actor: { login: 'someone' }, triggering_actor: {}, repository: { private: false }, head_commit: { message: 'secret?' }
      }] }), { status: 200 });
    };
    const first = await github.getCiStatus({ now: NOW });
    assert.strictEqual(first.state, 'ok');
    assert.deepStrictEqual(Object.keys(first.runs[0]).sort(), ['branch', 'conclusion', 'created_at', 'event', 'head_sha', 'html_url', 'id', 'name', 'status', 'updated_at']);
    const second = await github.getCiStatus({ now: NOW + 30_000 });
    assert.strictEqual(second.cached, true);
    assert.strictEqual(seen.length, 1, 'served from cache within 60 s');
    assert.strictEqual(seen[0].headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.strictEqual(seen[0].headers.Accept, 'application/vnd.github+json');
    assert.strictEqual(seen[0].headers.Authorization, undefined, 'unauthenticated when no token is set');
    assert.match(seen[0].url, /\/repos\/kodspot\/electrical-platform\/actions\/runs\?per_page=10$/);

    github._resetCiCacheForTests();
    process.env.GH_ACTIONS_DISPATCH_TOKEN = SECRET_TOKEN;
    await github.getCiStatus({ now: NOW });
    assert.strictEqual(seen[1].headers.Authorization, `Bearer ${SECRET_TOKEN}`);
  });

  it('ci-status: failures become an "unavailable" state with a short reason, never throwing', async () => {
    globalThis.fetch = respond(500);
    assert.deepStrictEqual(
      (({ state, reason }) => ({ state, reason }))(await github.getCiStatus({ now: NOW })),
      { state: 'unavailable', reason: 'http 500' }
    );
    github._resetCiCacheForTests();
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    assert.strictEqual((await github.getCiStatus({ now: NOW })).reason, 'network');
  });
});
