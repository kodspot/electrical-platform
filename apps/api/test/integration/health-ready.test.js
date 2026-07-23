'use strict';

// Proves /health/ready's HTTP status code genuinely reflects database reachability
// in whichever state the environment actually is — unlike app-smoke.test.js's other
// tests, this one does not assume "no database" or require one; it checks the real
// current state via isDatabaseAvailable() and asserts the branch that state implies,
// so it's meaningful whether or not Postgres is reachable when the suite runs.

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable } = require('../helpers/db');

describe('health readiness reflects actual database state', () => {
  let dbAvailable;
  let app;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    app = await getTestApp();
  });

  it('GET /health/ready returns a status code and body consistent with real DB reachability', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    if (dbAvailable) {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.database, 'connected');
    } else {
      assert.strictEqual(res.statusCode, 503, 'readiness must fail loudly via status code when the DB is unreachable — this is what /health (kept for compatibility) does not do');
      assert.strictEqual(body.status, 'degraded');
      assert.strictEqual(body.database, 'disconnected');
    }
  });

  it('GET /health (combined, backward-compatible) always returns 200 regardless of DB state', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    assert.strictEqual(res.statusCode, 200, '/health must stay unconditionally 200 for existing consumers, whatever /health/ready does');
    assert.strictEqual(res.json().status, dbAvailable ? 'ok' : 'degraded');
  });
});
