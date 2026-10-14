'use strict';

// Fastify 5 compatibility (PR #11, ADR 0008): the behaviours the v5 migration guide changed
// that the rest of the suite did not exercise.
//  - reply.redirect(url, code): the legacy /{org}/{page} → /{org}/ele/{page} redirect.
//  - DELETE with Content-Type: application/json and an empty body (v5 rejects it by default):
//    every body-less DELETE the browser sends must still reach its route (our F14 parser).
//  - SSE over a real socket: raw writes, a pushed event, and cleanup on close.
//  - request.hostname no longer carries the port (the log serializer records it).

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const { buildApp, registerApp } = require('../../index');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const sse = require('../../src/services/sse');

describe('Fastify 5 compatibility', () => {
  let dbAvailable = false;
  let app;
  let base;
  const createdOrgIds = [];
  let org, admin, adminToken, superAdmin, saToken;
  let ip = 0;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = buildApp({ logger: false });
    await registerApp(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${app.server.address().port}`;
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    const login = async (u) => (await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.95.0.${++ip}` }, payload: { email: u.email, password: u.plaintextPassword } })).json().token;
    adminToken = await login(admin);
    saToken = await login(superAdmin);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
    await app.close();
  });

  it('the legacy /{org}/{page} URL redirects 301 to /{org}/ele/{page}', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'GET', url: `/${org.slug}/admin-dashboard` });
    assert.strictEqual(res.statusCode, 301, res.body.slice(0, 160));
    assert.strictEqual(res.headers.location, `/${org.slug}/ele/admin-dashboard`);
  });

  // Every body-less DELETE in public/ (grep "method: 'DELETE'"), sent the way App.apiFetch /
  // App.saFetch send it: Content-Type: application/json and no body. Unknown ids → 404 is the
  // expected answer; it must never be the empty-body rejection.
  const DELETE_CALL_SITES = [
    ['admin-alerts.html:400', '/api/alert-rules/:id'],
    ['admin-assets.html:438', '/api/assets/:id'],
    ['admin-categories.html:386', '/api/complaint-categories/:id'],
    ['admin-locations.html:659', '/api/locations/:id'],
    ['admin-locations.html:670', '/api/locations/:id?force=true'],
    ['admin-supervisors.html:601', '/api/supervisors/:id/permanent'],
    ['admin-templates.html:477', '/api/inspection-templates/:id'],
    ['admin-workers.html:590', '/api/workers/:id/permanent'],
    ['superadmin-dashboard.html:1132', '/api/superadmin/organizations/:id', 'sa']
  ];
  for (const [site, route, who] of DELETE_CALL_SITES) {
    it(`DELETE with an empty JSON body reaches its route — ${site}`, async (t) => {
      if (!dbAvailable) return t.skip('No database available in this environment');
      const res = await app.inject({
        method: 'DELETE', url: route.replace(':id', crypto.randomUUID()),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${who === 'sa' ? saToken : adminToken}` },
        payload: ''
      });
      const body = res.body || '';
      assert.ok(!/FST_ERR_CTP|Body cannot be empty|Unsupported Media Type/i.test(body), `${site}: ${res.statusCode} ${body.slice(0, 120)}`);
      assert.ok(res.statusCode < 500, `${site}: ${res.statusCode}`);
      assert.notStrictEqual(res.statusCode, 415);
    });
  }

  it('SSE over a real socket: event-stream headers, the connected event, a pushed event, cleanup on close', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const before = sse.getConnectionStats();
    const chunks = [];
    const { res, req } = await new Promise((resolve, reject) => {
      const r = http.get(`${base}/api/notifications/stream`, { headers: { authorization: `Bearer ${adminToken}` } }, (response) => resolve({ res: response, req: r }));
      r.on('error', reject);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const waitFor = (re) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}: ${chunks.join('')}`)), 5000);
      const check = () => { if (re.test(chunks.join(''))) { clearTimeout(timer); resolve(); } };
      res.on('data', (c) => { chunks.push(c.toString()); check(); });
      check();
    });
    await waitFor(/event: connected/);
    sse.sendToRecipient(org.id, 'user', admin.id, 'notification', { title: 'fastify5-compat' });
    await waitFor(/fastify5-compat/);
    req.destroy();
    for (let i = 0; i < 40 && JSON.stringify(sse.getConnectionStats()) !== JSON.stringify(before); i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepStrictEqual(sse.getConnectionStats(), before, 'the connection is removed when the client goes away');
  });

  it('request.hostname has no port in v5; request.host keeps it', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const sub = buildApp({ logger: false });
    sub.get('/__host_probe', async (request) => ({ hostname: request.hostname, host: request.host }));
    await sub.ready();
    const res = await sub.inject({ method: 'GET', url: '/__host_probe', headers: { host: 'example.test:8443' } });
    assert.deepStrictEqual(res.json(), { hostname: 'example.test', host: 'example.test:8443' });
    await sub.close();
  });
});
