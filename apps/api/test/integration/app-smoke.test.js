'use strict';

// These tests exercise the fully-wired app (all plugins + all ~25 route files
// registered, via the same registerApp() used in production) through real HTTP-level
// fastify.inject() calls. They deliberately only cover paths that reject a request
// before any database call is made, so they run correctly with no Postgres instance
// available — see test/integration/tenant-isolation.test.js and
// test/integration/ticket-lifecycle.test.js for the deeper, database-backed tests.

const test = require('node:test');
const assert = require('node:assert');

// These fallbacks let the smoke tests run with no .env at all. They must meet the
// boot-time minimum length (JWT/COOKIE >= 32, see src/config/env.js, WP13) — the
// original 30-char JWT fallback predated that rule and made `npm test` fail from a
// fresh shell, since it is set before dotenv loads the real .env and dotenv does not
// override an already-set value. [platform-M2]
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests-min32chars';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-for-unit-tests';

const { getTestApp } = require('../helpers/build-app');
const jwt = require('jsonwebtoken');

test('GET /health responds without a live database, reporting degraded status', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.strictEqual(res.statusCode, 200, 'health endpoint must never hard-fail, even when the DB is unreachable');
  const body = res.json();
  assert.ok(['ok', 'degraded'].includes(body.status));
  assert.ok(['connected', 'disconnected'].includes(body.database));
});

test('a protected route rejects a request with no Authorization header, before touching the database', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/tickets' });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.json().error, 'Unauthorized');
});

test('a protected route rejects a garbage bearer token', async () => {
  const app = await getTestApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/tickets',
    headers: { authorization: 'Bearer not-a-real-token' }
  });

  assert.strictEqual(res.statusCode, 401);
});

test('a protected route rejects a well-formed JWT signed with the wrong secret', async () => {
  const app = await getTestApp();
  const forgedToken = jwt.sign({ userId: 'fake-user-id', orgId: 'fake-org-id', role: 'ADMIN' }, 'wrong-secret');

  const res = await app.inject({
    method: 'GET',
    url: '/api/tickets',
    headers: { authorization: `Bearer ${forgedToken}` }
  });

  assert.strictEqual(res.statusCode, 401, 'a token signed with the wrong secret must never be accepted as valid');
});

test('a protected route rejects an expired-by-signature-mismatch token even with a plausible payload shape', async () => {
  const app = await getTestApp();
  // Same payload shape a real login would issue, but never signed by this server's JWT_SECRET
  const forgedToken = jwt.sign(
    { userId: 'any-user-id', orgId: 'any-org-id', role: 'SUPER_ADMIN' },
    'attacker-controlled-secret',
    { expiresIn: '24h' }
  );

  const res = await app.inject({
    method: 'GET',
    url: '/api/superadmin/organizations',
    headers: { authorization: `Bearer ${forgedToken}` }
  });

  assert.strictEqual(res.statusCode, 401, 'a forged SUPER_ADMIN token must not grant access');
});

test('security headers (Helmet) are present on responses', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
});

test('an unknown API route returns 404 rather than leaking a stack trace', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/this-route-does-not-exist' });

  assert.strictEqual(res.statusCode, 404);
});

test('public complaint submission rejects a malformed locationId before any database lookup', async () => {
  const app = await getTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/complaint',
    payload: { locationId: 'not-a-valid-uuid', issueType: 'LIGHT_NOT_WORKING' }
  });

  assert.strictEqual(res.statusCode, 400, 'a non-UUID locationId must be rejected by format validation, not reach Prisma');
});

test('GET /health/live always reports ok and checks no dependency, even without a live database', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/health/live' });

  assert.strictEqual(res.statusCode, 200, 'liveness must not fail just because a downstream dependency is down');
  assert.strictEqual(res.json().status, 'ok');
});

test('error responses include a requestId that matches the request-scoped log correlation ID', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/this-route-does-not-exist' });

  assert.strictEqual(res.statusCode, 404);
  const body = res.json();
  assert.ok(body.requestId, 'a 404 response must include a requestId for log correlation');
  assert.match(body.requestId, /^req-/, 'requestId should match the genReqId format configured in index.js');
});

test('a thrown validation error (ZodError) includes a requestId, correlated via the centralized error handler', async () => {
  const app = await getTestApp();
  // POST /api/auth/login is unauthenticated and validates its body with Zod before
  // any database call — z.string().email() rejects this synchronously, throwing a
  // ZodError that's caught by the centralized error handler (not a manual reply.send
  // like the auth middleware's 401s, which intentionally aren't covered — see below).
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'not-an-email', password: 'x' }
  });

  assert.strictEqual(res.statusCode, 400);
  const body = res.json();
  assert.ok(body.requestId, 'errors thrown and caught by registerErrorHandlers must include a requestId');
  assert.match(body.requestId, /^req-/);
});
