'use strict';

// F14 / BUG-0006: browser parity for body-less JSON requests.
//
// public/js/app.js's apiFetch / saFetch / elecFetch always send Content-Type:
// application/json, so a POST/PATCH with no body reaches the server as JSON with an empty
// body. Fastify's default parser rejected that with 400 FST_ERR_CTP_EMPTY_JSON_BODY before
// auth even ran — breaking, among others, the electrician's Pick Up. Below is EVERY body-less
// POST/PATCH call site in public/ (found by parsing every apiFetch/saFetch/elecFetch/supFetch
// call and app.js's notification fetcher), each replayed exactly as a browser sends it.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestWorker
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const NO_ID = '00000000-0000-4000-8000-000000000000';

// [public/ call site, method, url, which token]
const CALL_SITES = [
  ['admin-alerts.html:527 (apiFetch)', 'PATCH', `/api/alerts/${NO_ID}/acknowledge`, 'admin'],
  ['admin-alerts.html:533 (apiFetch)', 'PATCH', '/api/alerts/acknowledge-all', 'admin'],
  ['admin-alerts.html:581 (apiFetch)', 'POST', '/api/ai-insights/generate', 'admin'],
  ['admin-templates.html:464 (apiFetch)', 'POST', `/api/inspection-templates/${NO_ID}/duplicate`, 'admin'],
  ['electrician-tickets.html:262 (elecFetch)', 'POST', `/api/worker/tickets/${NO_ID}/pickup`, 'worker'],
  ['supervisor-tickets.html:475 (supFetch)', 'POST', `/api/tickets/${NO_ID}/accept`, 'supervisor'],
  ['supervisor-tickets.html:490 (supFetch)', 'POST', `/api/tickets/${NO_ID}/pickup`, 'supervisor'],
  ['js/superadmin-quality.js:225 (saFetch)', 'POST', '/api/superadmin/qa/checks', 'superadmin'],
  ['js/app.js:1036 notifications read-all (apiFetch)', 'PATCH', '/api/notifications/read-all', 'admin'],
  ['js/app.js:1036 notifications read-all (elecFetch)', 'PATCH', '/api/worker/notifications/read-all', 'worker'],
  ['js/app.js:1264 notification read (apiFetch)', 'PATCH', `/api/notifications/${NO_ID}/read`, 'admin'],
  ['js/app.js:1264 notification read (elecFetch)', 'PATCH', `/api/worker/notifications/${NO_ID}/read`, 'worker']
];

describe('F14 — body-less JSON requests behave as the browser expects', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  const tokens = {};
  let superAdmin;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    const org = await createTestOrg();
    createdOrgIds.push(org.id);
    const login = async (u) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: u.plaintextPassword } })).json().token;
    tokens.admin = await login(await createTestUser(org.id, { role: 'ADMIN' }));
    tokens.supervisor = await login(await createTestUser(org.id, { role: 'SUPERVISOR' }));
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    tokens.superadmin = await login(superAdmin);
    const worker = await createTestWorker(org.id, { pin: '123456' });
    tokens.worker = (await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '123456' } })).json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await prisma.auditLog.deleteMany({ where: { actorId: superAdmin.id } });
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('every body-less POST/PATCH call site in public/ is never rejected as an empty JSON body, and never 500s', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const prevDriver = process.env.STORAGE_DRIVER;
    process.env.STORAGE_DRIVER = 'local'; // keeps the production checks off the network
    const results = [];
    try {
      let ip = 0;
      for (const [site, method, url, who] of CALL_SITES) {
        for (const payload of ['', '  \n ']) {
          const res = await app.inject({
            method, url, payload,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}`, 'x-forwarded-for': `10.140.0.${++ip}` }
          });
          let code = '';
          let message = '';
          try { ({ error: code = '', message = '' } = res.json()); } catch { /* streamed / non-JSON body */ }
          results.push({ site, method, url, payload: JSON.stringify(payload), status: res.statusCode, code, message });
        }
      }
    } finally {
      process.env.STORAGE_DRIVER = prevDriver === undefined ? '' : prevDriver;
    }
    // A rejection by the body parser (empty body, or whitespace read as invalid JSON) or any
    // 5xx is the defect. A 400 from the route's own business rule — e.g. "AI is not enabled
    // for this organization" — means the request reached the handler, which is the point.
    const parserRejected = (r) => /^FST_ERR_CTP_/.test(r.code) || /JSON|Body cannot be empty/i.test(`${r.code} ${r.message}`);
    const bad = results.filter((r) => parserRejected(r) || r.status >= 500);
    assert.deepStrictEqual(bad, [], `browser-style requests were rejected:\n${bad.map((r) => `${r.status} ${r.code} ${r.message} ${r.method} ${r.url} (${r.site}, body ${r.payload})`).join('\n')}`);
    for (const r of results) assert.ok([200, 201, 204, 400, 401, 403, 404, 429].includes(r.status), `${r.site}: unexpected ${r.status}`);
    const reachedHandler400 = results.filter((r) => r.status === 400).map((r) => `${r.url}: ${r.code}`);
    assert.ok(reachedHandler400.every((s) => s.startsWith('/api/ai-insights/generate')), `only the AI rule may answer 400 here: ${reachedHandler400.join(', ')}`);
  });

  it('malformed JSON is still rejected with 400', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email": ' });
    assert.strictEqual(res.statusCode, 400);
  });

  it('prototype-poisoning payloads are still rejected (__proto__ and constructor.prototype)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    for (const payload of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}']) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${payload}`);
    }
    assert.strictEqual({}.polluted, undefined);
  });

  it('a normal JSON body still parses (charset parameter included)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' })
    });
    assert.strictEqual(res.statusCode, 401, 'parsed and reached the login handler');
  });
});
