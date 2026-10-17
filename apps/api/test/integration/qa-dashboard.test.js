'use strict';

// WP-Q: the QA ingest (POST /api/qa/runs, token-authenticated, outside JWT) and the
// SUPER_ADMIN-only Quality API and page. No real network: production checks run with
// STORAGE_DRIVER=local and no SMTP/GitHub credentials (those paths are unit-tested with
// stubs in test/production-checks.test.js).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestWorker
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { recordQaRun } = require('../../src/routes/qa');

const INGEST_TOKEN = `qa-ingest-test-${crypto.randomBytes(8).toString('hex')}`;
const MARKER = `__wp1_test__qa_${crypto.randomBytes(4).toString('hex')}`;
const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOiJ3cC1xIn0.Q2FuYXJ5U2lnbmF0dXJlV1BR';

const runBody = (overrides = {}) => ({
  source: 'ci',
  commitSha: 'abc1234',
  ref: `  ${MARKER}  `,
  event: 'pull_request',
  runUrl: 'https://github.com/kodspot/electrical-platform/actions/runs/1',
  nodeVersion: 'v20.20.2',
  summary: {
    status: 'passed',
    counts: { tests: 10, pass: 9, fail: 1, cancelled: 0, skipped: 0, todo: 0 },
    durationMs: 1234.4,
    tiers: [{ tier: 'unit', files: 1, tests: 10 }],
    failures: [{ test: 't', file: 'test/x.test.js', status: 'failed', detail: `boom ${CANARY_JWT}` }]
  },
  ...overrides
});

describe('WP-Q — QA run ingest and the super-admin Quality API', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  const createdRunIds = [];
  let superAdmin, saToken, adminToken, supToken, workerToken;

  const ingest = (body, token = INGEST_TOKEN) => app.inject({
    method: 'POST', url: '/api/qa/runs', payload: body,
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const asSA = (url, method = 'GET') => app.inject({ method, url, headers: { authorization: `Bearer ${saToken}` } });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    const org = await createTestOrg();
    createdOrgIds.push(org.id);
    const login = async (u) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: u.plaintextPassword } })).json().token;
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    saToken = await login(superAdmin);
    adminToken = await login(await createTestUser(org.id, { role: 'ADMIN' }));
    supToken = await login(await createTestUser(org.id, { role: 'SUPERVISOR' }));
    const worker = await createTestWorker(org.id, { pin: '123456' });
    workerToken = (await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '123456' } })).json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    process.env.QA_INGEST_TOKEN = '';
    await prisma.qaRun.deleteMany({ where: { OR: [{ id: { in: createdRunIds } }, { ref: { startsWith: '__wp1_test__qa_' } }] } });
    await prisma.auditLog.deleteMany({ where: { actorId: superAdmin.id } });
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('ingest: 404 while QA_INGEST_TOKEN is unset', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = '';
    assert.strictEqual((await ingest(runBody())).statusCode, 404);
  });

  it('ingest: 401 for a missing or wrong token', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = INGEST_TOKEN;
    assert.strictEqual((await ingest(runBody(), null)).statusCode, 401);
    assert.strictEqual((await ingest(runBody(), `${INGEST_TOKEN}x`)).statusCode, 401);
  });

  it('ingest: 201 returns only the id; strings are trimmed, details capped and scrubbed', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = INGEST_TOKEN;
    const body = runBody();
    // ~180 KB: under the 256 KB body limit, but each detail is over the 1000-char cap.
    body.summary.failures = Array.from({ length: 150 }, (_, i) => ({ test: `t${i}`, detail: `${'y'.repeat(1100)} ${CANARY_JWT}` }));
    body.summary.failures[0].detail = `boom ${CANARY_JWT}`;
    const res = await ingest(body);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.json()), ['id']);
    createdRunIds.push(res.json().id);

    const row = await prisma.qaRun.findUnique({ where: { id: res.json().id } });
    assert.strictEqual(row.ref, MARKER, 'ref trimmed');
    assert.deepStrictEqual([row.total, row.passed, row.failed, row.durationMs], [10, 9, 1, 1234]);
    assert.strictEqual(row.details.failures.length, 100, 'failures capped at 100');
    assert.ok(row.details.failures[1].detail.length <= 1000, 'long strings truncated');
    assert.ok(!JSON.stringify(row.details).includes(CANARY_JWT), 'JWT-shaped strings scrubbed');
  });

  it('ingest: 413 for a body over 256 KB', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = INGEST_TOKEN;
    const body = runBody();
    body.summary.blob = 'z'.repeat(300 * 1024);
    assert.strictEqual((await ingest(body)).statusCode, 413);
  });

  it('ingest: 400 for an invalid body, echoing nothing back', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = INGEST_TOKEN;
    const res = await ingest({ source: 'nightly', ref: MARKER });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.json(), { error: 'Invalid payload' });
  });

  it('ingest: the QA-2 sources (impact, prod-smoke) are accepted and listed by their source filter', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.QA_INGEST_TOKEN = INGEST_TOKEN;
    // Own client address: the ingest allows 10 posts per minute per address.
    const post = (body) => app.inject({
      method: 'POST', url: '/api/qa/runs', payload: body,
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'x-forwarded-for': '10.98.0.1' }
    });
    const impact = runBody({ source: 'impact', ref: `${MARKER}-impact` });
    impact.summary = { status: 'not_covered', counts: { tests: 2, pass: 1, fail: 1 }, durationMs: null, items: [{ kind: 'page', id: 'admin-tickets', covered: true }], uncovered: ['route POST /api/x'] };
    const smoke = runBody({ source: 'prod-smoke', ref: `${MARKER}-smoke` });
    smoke.summary = { status: 'passed', counts: { tests: 3, pass: 3, fail: 0 }, durationMs: 900, checks: [{ check: 'health', status: 'passed', detail: '' }], methods: { GET: 40, HEAD: 0 }, readOnly: true };
    for (const body of [impact, smoke]) {
      const res = await post(body);
      assert.strictEqual(res.statusCode, 201, `${body.source} accepted`);
      createdRunIds.push(res.json().id);
    }
    assert.strictEqual((await post(runBody({ source: 'prod' }))).statusCode, 400, 'an unknown source is still rejected');

    const listed = (await asSA('/api/superadmin/qa/runs?source=prod-smoke&limit=100')).json().runs;
    assert.ok(listed.length && listed.every((r) => r.source === 'prod-smoke'));
    const run = listed.find((r) => r.ref === `${MARKER}-smoke`);
    const detail = (await asSA(`/api/superadmin/qa/runs/${run.id}`)).json().details;
    assert.deepStrictEqual(detail.methods, { GET: 40, HEAD: 0 });
    assert.strictEqual(detail.checks[0].check, 'health');
    const impacts = (await asSA('/api/superadmin/qa/runs?source=impact&limit=100')).json().runs;
    assert.ok(impacts.some((r) => r.ref === `${MARKER}-impact`) && impacts.every((r) => r.source === 'impact'));

    // Without ?source= the list and the trend are the test suites only: the existing tabs
    // are unchanged by the reports.
    const all = (await asSA('/api/superadmin/qa/runs?limit=100')).json().runs;
    assert.ok(all.length && all.every((r) => ['ci', 'local', 'e2e'].includes(r.source)), 'the default list holds test-suite runs only');
    const trend = (await asSA('/api/superadmin/qa/trend?limit=100')).json().runs;
    assert.ok(trend.every((r) => ['ci', 'local', 'e2e'].includes(r.source)), 'the default trend holds test-suite runs only');
  });

  it('the Quality API rejects ADMIN, SUPERVISOR and worker tokens', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    let ip = 0;
    for (const tok of [adminToken, supToken, workerToken]) {
      for (const url of ['/api/superadmin/qa/runs', '/api/superadmin/qa/runs?source=impact', '/api/superadmin/qa/runs?source=prod-smoke', '/api/superadmin/qa/trend', '/api/superadmin/qa/ci-status']) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
        assert.ok([401, 403].includes(res.statusCode), `${url} must reject a non-super-admin (got ${res.statusCode})`);
      }
      // A distinct client IP per call, so these rejections do not use up the super-admin's
      // one-per-30-seconds checks slot (the rate limit is keyed by IP).
      const checks = await app.inject({
        method: 'POST', url: '/api/superadmin/qa/checks',
        headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': `10.99.0.${++ip}` }
      });
      assert.ok([401, 403].includes(checks.statusCode), `checks must reject a non-super-admin (got ${checks.statusCode})`);
    }
  });

  it('a super-admin can list runs, open one with its details, and read the trend oldest-first', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const list = await asSA('/api/superadmin/qa/runs?limit=100');
    assert.strictEqual(list.statusCode, 200);
    const mine = list.json().runs.find((r) => r.ref === MARKER);
    assert.ok(mine, 'the ingested run is listed');
    assert.strictEqual(mine.details, undefined, 'the list omits details');
    const one = await asSA(`/api/superadmin/qa/runs/${mine.id}`);
    assert.strictEqual(one.json().details.tiers[0].tier, 'unit');
    assert.strictEqual((await asSA('/api/superadmin/qa/runs/00000000-0000-0000-0000-000000000000')).statusCode, 404);
    const trend = (await asSA('/api/superadmin/qa/trend?limit=100')).json().runs;
    const times = trend.map((r) => new Date(r.createdAt).getTime());
    assert.deepStrictEqual(times, [...times].sort((x, y) => x - y));
  });

  it('only the newest N runs are kept (prune happens in the insert transaction)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const base = { source: 'local', ref: `${MARKER}-prune`, status: 'passed' };
    const before = await prisma.qaRun.count();
    const a = await recordQaRun(base, { keep: before + 2 });
    const b = await recordQaRun(base, { keep: before + 2 });
    const c = await recordQaRun(base, { keep: before + 2 });
    createdRunIds.push(a.id, b.id, c.id);
    assert.strictEqual(await prisma.qaRun.count(), before + 2);
    assert.ok(await prisma.qaRun.findUnique({ where: { id: c.id } }), 'the newest run is kept');
  });

  it('production checks stream NDJSON, write a status-only audit row, and are rate-limited', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.STORAGE_DRIVER = 'local';
    try {
      const res = await asSA('/api/superadmin/qa/checks', 'POST');
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /application\/x-ndjson/);
      const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
      const done = lines.pop();
      assert.strictEqual(done.done, true);
      const names = lines.map((l) => l.name);
      assert.ok(names.includes('database') && names.includes('offsite-backups') && names.includes('email'));
      assert.strictEqual(lines.find((l) => l.name === 'database').status, 'PASS');
      assert.strictEqual(lines.find((l) => l.name === 'offsite-backups').status, 'SKIPPED');
      assert.ok(!/https?:\/\/|postgres(ql)?:\/\//.test(res.body), 'no URL in any check detail');

      let audit = null;
      for (let i = 0; i < 40 && !audit; i++) {
        audit = await prisma.auditLog.findFirst({ where: { actorId: superAdmin.id, action: 'sa_production_checks_run' } });
        if (!audit) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(audit, 'an audit row is written');
      assert.ok(audit.newValue.statuses.every((s) => Object.keys(s).sort().join() === 'name,status'), 'the audit row holds statuses only');

      assert.strictEqual((await asSA('/api/superadmin/qa/checks', 'POST')).statusCode, 429, 'one run per 30 s');
    } finally {
      process.env.STORAGE_DRIVER = '';
    }
  });

  it('serves the Quality page', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'GET', url: '/superadmin-quality' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /superadmin-quality\.js/);
    assert.doesNotMatch(res.body, /<script>(?!<\/script>)/, 'no inline script');
  });
});
