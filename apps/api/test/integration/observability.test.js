'use strict';

// Tests for the M6 observability additions: the /health/info diagnostics endpoint, the
// x-request-id correlation header, and the diagnostics source-of-truth module.
// These exercise the fully-wired app via app.inject() and need no database (the health
// endpoints report a degraded database in the body rather than failing).

const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests-min32chars';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-for-unit-tests';

const { getTestApp } = require('../helpers/build-app');
const { buildInfo, configStatus } = require('../../src/lib/diagnostics');

test('GET /health/info returns build, dependency, and configuration diagnostics', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/health/info' });

  assert.strictEqual(res.statusCode, 200, '/health/info is always 200 (degraded state is in the body)');
  const body = res.json();
  assert.ok(['ok', 'degraded'].includes(body.status));

  // Build metadata
  assert.ok(body.build, 'build metadata present');
  assert.ok(typeof body.build.version === 'string');
  assert.ok(typeof body.build.environment === 'string');
  assert.ok(['r2', 'local'].includes(body.build.storageDriver));
  assert.ok(typeof body.build.uptimeSeconds === 'number');

  // Dependencies (reused from existing status surfaces)
  assert.ok(body.dependencies, 'dependency summary present');
  assert.ok(['connected', 'disconnected'].includes(body.dependencies.database));
  assert.ok(body.dependencies.circuitBreakers.database, 'db breaker status present');
  assert.ok(body.dependencies.circuitBreakers.aiProvider, 'ai breaker status present');
  assert.ok(body.dependencies.sse, 'sse connection stats present');

  // Configuration — booleans only, never secret values
  assert.ok(body.configuration, 'configuration summary present');
  for (const [k, v] of Object.entries(body.configuration)) {
    assert.strictEqual(typeof v, 'boolean', `configuration.${k} must be a boolean (no secret values)`);
  }
});

test('every response carries an x-request-id header for correlation', async () => {
  const app = await getTestApp();
  const res = await app.inject({ method: 'GET', url: '/health/live' });
  assert.ok(res.headers['x-request-id'], 'x-request-id header is set');
  assert.match(res.headers['x-request-id'], /^req-/, 'uses the app request-id format');
});

test('two requests get distinct request ids', async () => {
  const app = await getTestApp();
  const a = await app.inject({ method: 'GET', url: '/health/live' });
  const b = await app.inject({ method: 'GET', url: '/health/live' });
  assert.notStrictEqual(a.headers['x-request-id'], b.headers['x-request-id']);
});

test('diagnostics module exposes version/environment and boolean-only config (no secrets)', () => {
  const info = buildInfo();
  assert.ok(typeof info.version === 'string' && info.version.length > 0);
  assert.ok(typeof info.node === 'string');
  assert.ok(typeof info.environment === 'string');

  const cfg = configStatus();
  const expectedKeys = ['email', 'globalAiKey', 'errorAlerting', 'ipHashPepper'];
  for (const k of expectedKeys) assert.strictEqual(typeof cfg[k], 'boolean', `${k} must be boolean`);
  // No value in the config summary should look like a secret (defensive).
  for (const v of Object.values(cfg)) assert.strictEqual(typeof v, 'boolean');
});
