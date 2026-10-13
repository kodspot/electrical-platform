'use strict';

// F15 / BUG-0008 at the app level:
// - a worker token on a staff API answers 401 before any query (it used to throw a Prisma
//   validation error, which counted toward the database circuit breaker);
// - /api/images accepts staff AND worker tokens with the same checks as the header-based
//   auth paths, and another org's key answers 404;
// - five worker image loads no longer open the breaker for everyone else;
// - the ?token= never reaches a log line; /health still reports the breaker.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

// The local storage driver reads its root once, at load: set it before the app loads.
const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f15-images-'));
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const { buildApp, registerApp } = require('../../index');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestWorker } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { dbBreaker } = require('../../src/lib/circuit-breaker');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function resetDbBreaker() {
  dbBreaker.state = 'CLOSED';
  dbBreaker.failures = [];
  dbBreaker.lastOpenedAt = 0;
}

describe('F15 — /api/images accepts staff and worker tokens; worker tokens never trip the database breaker', () => {
  let dbAvailable = false;
  let app;
  const lines = [];
  const createdOrgIds = [];
  const extraUserIds = [];
  let orgA, orgB, admin, superAdmin, worker;
  const sign = (payload, opts = {}) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
  const img = (orgId, token) => `/api/images/uploads/${orgId}/f15.png?token=${token}`;
  const counters = () => { const s = dbBreaker.getStatus(); return { ok: s.totalSuccesses, fail: s.totalFailures }; };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = buildApp({ logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } }) } });
    await registerApp(app);
    await app.ready();
    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);
    admin = await createTestUser(orgA.id, { role: 'ADMIN' });
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    extraUserIds.push(superAdmin.id);
    worker = await createTestWorker(orgA.id, { pin: '246810' });
    for (const org of [orgA, orgB]) {
      fs.mkdirSync(path.join(STORAGE_DIR, 'uploads', org.id), { recursive: true });
      fs.writeFileSync(path.join(STORAGE_DIR, 'uploads', org.id, 'f15.png'), PNG);
    }
  });

  afterEach(resetDbBreaker);

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
    await app.close();
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  });

  const workerToken = () => sign({ workerId: worker.id, orgId: orgA.id });
  const staffToken = (u) => sign({ userId: u.id, orgId: u.orgId, role: u.role });

  it('a worker reads an image of its own org → 200', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'GET', url: img(orgA.id, workerToken()) });
    assert.strictEqual(res.statusCode, 200, res.body.slice(0, 120));
    assert.match(res.headers['content-type'], /image\/png/);
    assert.ok(res.rawPayload.equals(PNG));
  });

  it('a worker reading another org\'s image gets 404 (not 403)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'GET', url: img(orgB.id, workerToken()) });
    assert.strictEqual(res.statusCode, 404);
  });

  it('a deactivated worker gets 401', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const off = await createTestWorker(orgA.id, { isActive: false });
    const res = await app.inject({ method: 'GET', url: img(orgA.id, sign({ workerId: off.id, orgId: orgA.id })) });
    assert.strictEqual(res.statusCode, 401);
  });

  it('a worker token issued before tokenInvalidBefore gets 401', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const w = await createTestWorker(orgA.id, { tokenInvalidBefore: new Date() });
    const old = sign({ workerId: w.id, orgId: orgA.id, iat: Math.floor(Date.now() / 1000) - 120 });
    const res = await app.inject({ method: 'GET', url: img(orgA.id, old) });
    assert.strictEqual(res.statusCode, 401);
  });

  it('a worker of a suspended org gets 403', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const org = await createTestOrg({ status: 'SUSPENDED' });
    createdOrgIds.push(org.id);
    const w = await createTestWorker(org.id);
    const res = await app.inject({ method: 'GET', url: img(org.id, sign({ workerId: w.id, orgId: org.id })) });
    assert.strictEqual(res.statusCode, 403);
  });

  it('staff: own org 200, another org 404, SUPER_ADMIN any org 200', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgA.id, staffToken(admin)) })).statusCode, 200);
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgB.id, staffToken(admin)) })).statusCode, 404);
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgB.id, staffToken(superAdmin)) })).statusCode, 200);
  });

  it('staff: inactive user 401, token issued before tokenInvalidBefore 401, missing or bad token 401', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const off = await createTestUser(orgA.id, { role: 'ADMIN', isActive: false });
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgA.id, staffToken(off)) })).statusCode, 401);
    const reset = await createTestUser(orgA.id, { role: 'ADMIN', tokenInvalidBefore: new Date() });
    const old = sign({ userId: reset.id, orgId: orgA.id, role: 'ADMIN', iat: Math.floor(Date.now() / 1000) - 120 });
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgA.id, old) })).statusCode, 401);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/images/uploads/${orgA.id}/f15.png` })).statusCode, 401);
    assert.strictEqual((await app.inject({ method: 'GET', url: img(orgA.id, 'not-a-jwt') })).statusCode, 401);
  });

  it('a token with neither userId nor workerId gets 401 without any query', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const before = counters();
    const res = await app.inject({ method: 'GET', url: img(orgA.id, sign({ orgId: orgA.id, role: 'ADMIN' })) });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(counters(), before, 'no Prisma operation ran');
  });

  it('a worker token on a staff API answers 401 before any query (no Prisma error)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const before = counters();
    const res = await app.inject({ method: 'GET', url: '/api/tickets', headers: { authorization: `Bearer ${workerToken()}` } });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(counters(), before, 'no Prisma operation ran, so nothing could count as a failure');
  });

  it('BUG-0008: five worker image loads then an unrelated request — the breaker stays CLOSED and the request succeeds', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: img(orgA.id, workerToken()) });
      assert.notStrictEqual(res.statusCode, 503);
    }
    assert.strictEqual(dbBreaker.state, 'CLOSED');
    const unrelated = await app.inject({ method: 'GET', url: '/api/locations', headers: { authorization: `Bearer ${staffToken(admin)}` } });
    assert.strictEqual(unrelated.statusCode, 200, unrelated.body.slice(0, 120));
  });

  it('no log line contains an image token', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const token = workerToken();
    await app.inject({ method: 'GET', url: img(orgA.id, token) });
    await app.inject({ method: 'GET', url: img(orgB.id, token) });
    const text = lines.join('');
    assert.ok(text.includes('incoming request'), 'request lines were captured');
    assert.ok(!text.includes(token), 'a log line leaked the image token');
    assert.ok(!text.includes(token.split('.')[2]), 'a log line leaked the token signature');
  });

  it('/health still reports the database breaker', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200);
    const db = res.json().circuitBreakers.database;
    assert.strictEqual(db.name, 'database');
    assert.strictEqual(db.state, 'CLOSED');
    assert.strictEqual(typeof db.totalSuccesses, 'number');
    assert.strictEqual(db.recentFailures, 0);
  });
});
