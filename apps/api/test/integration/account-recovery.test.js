'use strict';

// Regression tests for WP14 (Account Recovery & Authentication Session UX).
// Covers the two new self-service recovery flows (user password reset,
// worker PIN reset) and the worker PIN-change session-UX fix.
//
// Security properties specifically verified, per WP14's acceptance criteria:
//   - reset tokens are single-use (a second attempt with the same token fails)
//   - reset tokens are time-limited (an expired token is rejected)
//   - the forgot-password/forgot-pin endpoints never reveal whether an
//     account exists (identical response for a real vs. a nonexistent account)
//   - a successful reset invalidates every session token issued before it
//   - worker PIN-change no longer forces an immediate re-login
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestWorker,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const crypto = require('node:crypto');
const { hashResetToken } = require('../../src/lib/security');

// A reset token issued the way the forgot flows issue one: the e-mailed (raw) token is what
// the user holds; only its hash is stored (BUG-0034). Returns the raw token.
async function seedResetToken(model, id) {
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma[model].update({ where: { id }, data: { resetToken: hashResetToken(raw), resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
  return raw;
}

// The forgot-password/reset-password/worker-forgot-pin/worker-reset-pin
// endpoints are correctly rate-limited per IP (strictRateLimit — 5 requests
// per 15 minutes), since they're unauthenticated and abuse-prone. That's the
// behavior under test elsewhere, not something to work around globally — but
// it means this file's many test cases must not all share app.inject()'s
// default synthetic client IP, or they'd trip each other's budget. Each test
// case gets its own simulated IP instead.
let ipCounter = 0;
function nextTestIp() {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

describe('WP14 — user self-service password reset', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN', email: `__wp1_test__-recovery@example.test` });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('POST /auth/forgot-password returns the same generic response for a real and a nonexistent email', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resReal = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: ip, payload: { email: admin.email } });
    const resFake = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: ip, payload: { email: '__wp1_test__-nobody@example.test' } });

    assert.strictEqual(resReal.statusCode, 200);
    assert.strictEqual(resFake.statusCode, 200);
    assert.deepStrictEqual(resReal.json(), resFake.json(), 'response body must not reveal whether the account exists');
  });

  it('sets a resetToken on the real account after a forgot-password request', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    await app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: nextTestIp(), payload: { email: admin.email } });

    const updated = await prisma.user.findUnique({ where: { id: admin.id } });
    assert.ok(updated.resetToken, 'a resetToken must be set');
    assert.ok(updated.resetTokenExpiresAt > new Date(), 'resetTokenExpiresAt must be in the future');
  });

  it('BUG-0034: only a hash of the reset token is stored — the database value itself cannot reset the password', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();
    await app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: ip, payload: { email: admin.email } });
    const { resetToken: stored } = await prisma.user.findUnique({ where: { id: admin.id } });
    assert.match(stored, /^[0-9a-f]{64}$/, 'a SHA-256 digest is stored');
    const res = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: ip, payload: { token: stored, newPassword: 'FromTheDb123' } });
    assert.strictEqual(res.statusCode, 400, 'someone who can read the database must not be able to reset the password');
  });

  it('POST /auth/reset-password with a valid token changes the password, reissues a token, and invalidates old sessions', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    // Capture a token issued before the reset.
    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: admin.plaintextPassword } });
    const oldToken = loginRes.json().token;

    // tokenInvalidBefore is compared against the token's `iat` at
    // second-level precision — see the same note on the worker PIN-change
    // test below. A short wait avoids racing that edge case.
    await new Promise(r => setTimeout(r, 2100));

    const resetToken = await seedResetToken('user', admin.id);

    const resetRes = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      remoteAddress: ip,
      payload: { token: resetToken, newPassword: 'BrandNewPass123' }
    });
    assert.strictEqual(resetRes.statusCode, 200);
    assert.ok(resetRes.json().token, 'reset-password must reissue a fresh token');

    // Old pre-reset token must now be rejected.
    const meWithOld = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${oldToken}` } });
    assert.strictEqual(meWithOld.statusCode, 401, 'a session token issued before the reset must be invalidated');

    // New token from the reset response must work.
    const meWithNew = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${resetRes.json().token}` } });
    assert.strictEqual(meWithNew.statusCode, 200);

    // New password actually works; old one no longer does.
    const loginNew = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: 'BrandNewPass123' } });
    assert.strictEqual(loginNew.statusCode, 200);
    const loginOld = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: admin.plaintextPassword } });
    assert.strictEqual(loginOld.statusCode, 401);
  });

  it('a reset token is single-use — a second reset with the same token fails', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resetToken = await seedResetToken('user', admin.id);

    const first = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: ip, payload: { token: resetToken, newPassword: 'FirstReset123' } });
    assert.strictEqual(first.statusCode, 200);

    const second = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: ip, payload: { token: resetToken, newPassword: 'SecondReset123' } });
    assert.strictEqual(second.statusCode, 400, 'reusing a spent reset token must fail');
  });

  it('an expired reset token is rejected', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resetToken = await seedResetToken('user', admin.id);

    // Simulate the token having expired an hour ago.
    await prisma.user.update({ where: { id: admin.id }, data: { resetTokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000) } });

    const res = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: ip, payload: { token: resetToken, newPassword: 'TooLate123' } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('a garbage/nonexistent token is rejected, not a 500', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: nextTestIp(), payload: { token: 'not-a-real-token', newPassword: 'WhoKnows123' } });
    assert.strictEqual(res.statusCode, 400);
  });
});

describe('WP14 — worker self-service PIN reset', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, worker;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    worker = await createTestWorker(org.id, { email: '__wp1_test__-worker-recovery@example.test', pin: '482913' });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('POST /auth/worker-forgot-pin returns the same generic response for a real and a nonexistent employeeId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resReal = await app.inject({ method: 'POST', url: '/api/auth/worker-forgot-pin', remoteAddress: ip, payload: { orgSlug: org.slug, employeeId: worker.employeeId } });
    const resFake = await app.inject({ method: 'POST', url: '/api/auth/worker-forgot-pin', remoteAddress: ip, payload: { orgSlug: org.slug, employeeId: 'NOT-A-REAL-ID' } });

    assert.strictEqual(resReal.statusCode, 200);
    assert.strictEqual(resFake.statusCode, 200);
    assert.deepStrictEqual(resReal.json(), resFake.json());
  });

  it('BUG-0034: only a hash of the PIN-reset token is stored — the database value itself cannot reset the PIN', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();
    await app.inject({ method: 'POST', url: '/api/auth/worker-forgot-pin', remoteAddress: ip, payload: { orgSlug: org.slug, employeeId: worker.employeeId } });
    const { resetToken: stored } = await prisma.worker.findUnique({ where: { id: worker.id } });
    assert.match(stored, /^[0-9a-f]{64}$/, 'a SHA-256 digest is stored');
    const res = await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', remoteAddress: ip, payload: { token: stored, newPin: '864201' } });
    assert.strictEqual(res.statusCode, 400, 'someone who can read the database must not be able to reset the PIN');
  });

  it('POST /auth/worker-reset-pin with a valid token changes the PIN, reissues a token, and invalidates old sessions', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '482913' } });
    const oldToken = loginRes.json().token;

    // See the note on the analogous user-side reset-password test above —
    // tokenInvalidBefore compares at second-level precision.
    await new Promise(r => setTimeout(r, 2100));

    const resetToken = await seedResetToken('worker', worker.id);

    const resetRes = await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', remoteAddress: ip, payload: { token: resetToken, newPin: '135790' } });
    assert.strictEqual(resetRes.statusCode, 200);
    assert.ok(resetRes.json().token);

    const meWithOld = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${oldToken}` } });
    assert.strictEqual(meWithOld.statusCode, 401, 'a worker session token issued before the reset must be invalidated');

    const meWithNew = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${resetRes.json().token}` } });
    assert.strictEqual(meWithNew.statusCode, 200);

    const loginNew = await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '135790' } });
    assert.strictEqual(loginNew.statusCode, 200);
  });

  it('a worker reset token is single-use', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resetToken = await seedResetToken('worker', worker.id);

    const first = await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', remoteAddress: ip, payload: { token: resetToken, newPin: '111222' } });
    assert.strictEqual(first.statusCode, 200);

    const second = await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', remoteAddress: ip, payload: { token: resetToken, newPin: '333444' } });
    assert.strictEqual(second.statusCode, 400);
  });

  it('an expired worker reset token is rejected', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ip = nextTestIp();

    const resetToken = await seedResetToken('worker', worker.id);

    await prisma.worker.update({ where: { id: worker.id }, data: { resetTokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000) } });

    const res = await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', remoteAddress: ip, payload: { token: resetToken, newPin: '999888' } });
    assert.strictEqual(res.statusCode, 400);
  });

  it('worker-forgot-pin does not send an email or set a token for a worker with no email on file', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const noEmailWorker = await createTestWorker(org.id, { email: null, pin: '246810' });

    const res = await app.inject({ method: 'POST', url: '/api/auth/worker-forgot-pin', remoteAddress: nextTestIp(), payload: { orgSlug: org.slug, employeeId: noEmailWorker.employeeId } });
    assert.strictEqual(res.statusCode, 200);

    const stored = await prisma.worker.findUnique({ where: { id: noEmailWorker.id } });
    assert.strictEqual(stored.resetToken, null, 'no reset token should be generated when there is no email to send it to');
  });
});

describe('WP14 — worker PIN-change session UX (L1 fix)', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, worker, workerToken;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    worker = await createTestWorker(org.id, { pin: '112233' });

    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '112233' } });
    workerToken = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('PATCH /auth/worker-pin returns a fresh token that keeps the session alive, instead of forcing a re-login', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    // tokenInvalidBefore is compared against the token's `iat` at
    // second-level precision (see middleware/auth.js / authenticateWorkerJWT)
    // — a real login-then-later-change-PIN sequence is always seconds to
    // hours apart, but this test's login (in before()) and this PATCH can
    // otherwise land in the same wall-clock second. A short wait keeps the
    // test honest about what it's asserting instead of racing that edge case.
    await new Promise(r => setTimeout(r, 2100));

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/auth/worker-pin',
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { currentPin: '112233', newPin: '445566' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json().token, 'PATCH /auth/worker-pin must reissue a fresh token, not just invalidate the old one');

    // The pre-change token must now be rejected...
    const meWithOld = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${workerToken}` } });
    assert.strictEqual(meWithOld.statusCode, 401);

    // ...but the newly-issued token must work immediately, with no re-login step.
    const meWithNew = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${res.json().token}` } });
    assert.strictEqual(meWithNew.statusCode, 200);
  });
});
