'use strict';

// F12 / BUG-0007: the emailed reset links (/reset-password?token=…, /worker-reset-pin?token=…)
// must open real pages — they used to fall through to the /:orgSlug route and answer
// "Organization not found". Plus two small hardening checks shipped with it: the super-admin
// org-switch audit row stores the URL without its query, and the PIN modal asks for exactly
// six digits.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');

const { buildApp, registerApp } = require('../../index');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const CANARY = 'c4n4ry0reset0token0f12aaaabbbbccccddddeeeeffff00001111222233334444';

describe('F12 — reset pages are served (not treated as an org slug) and keep tokens out of logs', () => {
  let dbAvailable = false;
  let app;
  const lines = [];
  const createdOrgIds = [];
  let superAdmin, saToken, org;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = buildApp({ logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } }) } });
    await registerApp(app);
    await app.ready();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    saToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: superAdmin.email, password: superAdmin.plaintextPassword } })).json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await prisma.auditLog.deleteMany({ where: { actorId: superAdmin.id } });
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
    await app.close();
  });

  for (const [page, script] of [['/reset-password', 'reset-password.js'], ['/worker-reset-pin', 'worker-reset-pin.js']]) {
    it(`GET ${page}?token=… serves the reset page as HTML`, async (t) => {
      if (!dbAvailable) return t.skip('No database available in this environment');
      const res = await app.inject({ method: 'GET', url: `${page}?token=${CANARY}` });
      assert.strictEqual(res.statusCode, 200, res.body.slice(0, 120));
      assert.match(res.headers['content-type'], /text\/html/);
      assert.ok(res.body.includes(script), 'the page loads its own script');
      assert.match(res.body, /<meta name="referrer" content="no-referrer">/);
      assert.doesNotMatch(res.body, /<script>(?!<\/script>)/, 'no inline script');
      assert.doesNotMatch(res.body, /Organization not found/);
    });
  }

  it('no log line contains the reset token', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    await app.inject({ method: 'GET', url: `/reset-password?token=${CANARY}` });
    await app.inject({ method: 'GET', url: `/worker-reset-pin?token=${CANARY}` });
    const text = lines.join('');
    assert.ok(text.includes('incoming request'), 'request lines were captured');
    assert.ok(!text.includes(CANARY), 'a log line leaked the reset token');
  });

  it('a super-admin org-switch audit row stores the URL without its query', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({
      method: 'GET', url: `/api/locations?token=${CANARY}&page=1`,
      headers: { authorization: `Bearer ${saToken}`, 'x-org-id': org.id }
    });
    assert.ok(res.statusCode < 500, `unexpected ${res.statusCode}`);
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      row = await prisma.auditLog.findFirst({ where: { actorId: superAdmin.id, action: 'sa_org_context_read' }, orderBy: { createdAt: 'desc' } });
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(row, 'an sa_org_context_read audit row was written');
    assert.strictEqual(row.newValue.url, '/api/locations');
    assert.ok(!JSON.stringify(row.newValue).includes(CANARY));
  });
});

describe('PIN modal asks for exactly six digits (matches the API)', () => {
  it('admin-workers.html: label, pattern, length and the client-side check all say 6 digits', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'admin-workers.html'), 'utf8');
    const modal = html.slice(html.indexOf('id="pinModal"'), html.indexOf('id="pinSaveBtn"'));
    assert.match(modal, /New PIN \(6 digits\)/);
    assert.doesNotMatch(html, /4-6 digits|\\d\{4,6\}|minlength="4"/);
    assert.strictEqual((modal.match(/pattern="\\d\{6\}" minlength="6" maxlength="6"/g) || []).length, 2);
    assert.match(html, /PIN must be exactly 6 digits/);
  });
});
