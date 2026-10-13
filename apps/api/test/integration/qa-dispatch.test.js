'use strict';

// C8: POST /api/superadmin/qa/dispatch — "Run full test suite now" on the Quality page.
// GitHub is stubbed (global fetch); no network. Checks the exact request sent, the exact
// outcome mapping, feature-off without a token, the 10-minute rate limit, role rejection,
// the status-only audit row, and that the token never reaches a response or a log line.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');

const { buildApp, registerApp } = require('../../index');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const DISPATCH_TOKEN = `github_pat_dispatchcanary${crypto.randomBytes(12).toString('hex')}`;
const MESSAGES = {
  not_on_main: 'the e2e workflow is not on main yet: it only becomes dispatchable after batch-2 is merged',
  token_rejected: 'dispatch token invalid, expired, or missing Actions write',
  github_unavailable: 'GitHub unavailable, try later'
};

describe('C8 — super-admin dispatch of the e2e workflow', () => {
  let dbAvailable = false;
  let app;
  const lines = [];
  const createdOrgIds = [];
  let superAdmin, saToken, adminToken;
  const realFetch = global.fetch;
  let calls = [];
  let ip = 0;

  /** Stub GitHub: `respond(call)` returns a Response, or throws to simulate network/timeout. */
  function stubGithub(respond) {
    global.fetch = async (url, init = {}) => {
      const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      return respond(call);
    };
  }

  const dispatch = (token = saToken) => app.inject({
    method: 'POST', url: '/api/superadmin/qa/dispatch',
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `10.88.0.${++ip}` }
  });

  async function latestAudit() {
    return prisma.auditLog.findFirst({ where: { actorId: superAdmin.id, action: 'sa_test_suite_dispatched' }, orderBy: { createdAt: 'desc' } });
  }

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = buildApp({ logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } }) } });
    await registerApp(app);
    await app.ready();
    const org = await createTestOrg();
    createdOrgIds.push(org.id);
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const login = async (u) => (await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.87.0.${++ip}` }, payload: { email: u.email, password: u.plaintextPassword } })).json().token;
    saToken = await login(superAdmin);
    adminToken = await login(admin);
  });

  afterEach(() => {
    global.fetch = realFetch;
    calls = [];
    process.env.GH_ACTIONS_DISPATCH_TOKEN = '';
  });

  after(async () => {
    if (!dbAvailable) return;
    await prisma.auditLog.deleteMany({ where: { actorId: superAdmin.id } });
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
    await app.close();
  });

  it('token unset → feature off: 404, no GitHub call, and ci-status says dispatchEnabled false', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = '';
    stubGithub(() => new Response('{"workflow_runs":[]}', { status: 200 }));
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!calls.some((c) => c.url.includes('/dispatches')), 'no dispatch call without a token');
    const ci = await app.inject({ method: 'GET', url: '/api/superadmin/qa/ci-status', headers: { authorization: `Bearer ${saToken}` } });
    assert.strictEqual(ci.json().dispatchEnabled, false);
  });

  it('200 → started with the run\'s html_url; sends the exact request; audit row holds statuses only', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    const htmlUrl = 'https://github.com/kodspot/electrical-platform/actions/runs/123456';
    stubGithub(() => new Response(JSON.stringify({ workflow_run_id: 123456, run_url: 'https://api.github.com/x', html_url: htmlUrl }), { status: 200 }));
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.json(), { state: 'started', message: 'started', url: htmlUrl });

    assert.strictEqual(calls.length, 1);
    const c = calls[0];
    assert.strictEqual(c.method, 'POST');
    assert.strictEqual(c.url, 'https://api.github.com/repos/kodspot/electrical-platform/actions/workflows/e2e.yml/dispatches');
    assert.deepStrictEqual(c.body, { ref: 'main', inputs: { requested_by: 'superadmin' } });
    assert.strictEqual(c.headers.Accept, 'application/vnd.github+json');
    assert.strictEqual(c.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.strictEqual(c.headers.Authorization, `Bearer ${DISPATCH_TOKEN}`);

    const audit = await latestAudit();
    assert.ok(audit);
    assert.deepStrictEqual(audit.newValue, { outcome: 'started', githubStatus: 200 });
  });

  it('204 → "started" with no link', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    stubGithub(() => new Response(null, { status: 204 }));
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.json(), { state: 'started', message: 'started', url: null });
  });

  it('a 200 whose html_url is not a github.com https URL is not returned as a link', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    stubGithub(() => new Response(JSON.stringify({ html_url: 'javascript:alert(1)' }), { status: 200 }));
    assert.strictEqual((await dispatch()).json().url, null);
  });

  for (const [status, outcome, code] of [[404, 'not_on_main', 409], [422, 'not_on_main', 409], [401, 'token_rejected', 502], [403, 'token_rejected', 502], [429, 'github_unavailable', 503], [500, 'github_unavailable', 503]]) {
    it(`GitHub ${status} → ${outcome} ("${MESSAGES[outcome]}")`, async (t) => {
      if (!dbAvailable) return t.skip('No database available in this environment');
      process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
      stubGithub(() => new Response(JSON.stringify({ message: 'Bad credentials', documentation_url: 'https://docs.github.com' }), { status }));
      const res = await dispatch();
      assert.strictEqual(res.statusCode, code);
      assert.deepStrictEqual(res.json(), { state: outcome, message: MESSAGES[outcome], url: null });
      assert.deepStrictEqual((await latestAudit()).newValue, { outcome, githubStatus: status });
    });
  }

  it('a timeout → "GitHub unavailable, try later"; a network error too', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    stubGithub(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
    let res = await dispatch();
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().message, MESSAGES.github_unavailable);
    assert.deepStrictEqual((await latestAudit()).newValue, { outcome: 'github_unavailable', githubStatus: 'timeout' });

    stubGithub(() => { throw new TypeError('fetch failed'); });
    res = await dispatch();
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual((await latestAudit()).newValue, { outcome: 'github_unavailable', githubStatus: 'network' });
  });

  it('one dispatch per 10 minutes from the same address', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    stubGithub(() => new Response(null, { status: 204 }));
    const headers = { authorization: `Bearer ${saToken}`, 'x-forwarded-for': '10.89.0.1' };
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/superadmin/qa/dispatch', headers })).statusCode, 202);
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/superadmin/qa/dispatch', headers })).statusCode, 429);
    assert.strictEqual(calls.filter((c) => c.url.includes('/dispatches')).length, 1);
  });

  it('SUPER_ADMIN only: an ADMIN token is refused and nothing is dispatched', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    stubGithub(() => new Response(null, { status: 204 }));
    const res = await dispatch(adminToken);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.length, 0);
  });

  it('the dispatch token never appears in a response, an audit row or a log line', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    process.env.GH_ACTIONS_DISPATCH_TOKEN = DISPATCH_TOKEN;
    const bodies = [];
    for (const status of [200, 204, 401, 404, 500]) {
      stubGithub(() => new Response(status === 204 ? null : JSON.stringify({ message: DISPATCH_TOKEN }), { status }));
      bodies.push((await dispatch()).body);
    }
    assert.ok(!bodies.join('').includes(DISPATCH_TOKEN), 'a response carried the token');
    const audits = await prisma.auditLog.findMany({ where: { actorId: superAdmin.id } });
    assert.ok(!JSON.stringify(audits).includes(DISPATCH_TOKEN), 'an audit row carried the token');
    assert.ok(!lines.join('').includes(DISPATCH_TOKEN), 'a log line carried the token');
    assert.ok(lines.join('').includes('/api/superadmin/qa/dispatch'), 'request lines were captured');
  });
});
