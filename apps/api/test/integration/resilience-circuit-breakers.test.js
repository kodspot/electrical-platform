'use strict';

// Regression tests for WP12 (Operational Resilience, Error Handling &
// Recovery). Covers two verified gaps:
//
// 1. lib/circuit-breaker.js's CircuitBreaker class had no dedicated test at
//    all, despite two singleton instances (dbBreaker, aiBreaker) already
//    existing and being displayed on /health — this exercises its state
//    machine directly (CLOSED -> OPEN -> HALF_OPEN -> CLOSED) with a fresh,
//    disposable instance so it can safely force real failures without
//    touching the shared dbBreaker/aiBreaker singletons other tests rely on.
// 2. dbBreaker existed but nothing ever routed a real query through it —
//    lib/prisma.js now wraps every Prisma model operation via a client
//    extension. This proves the wiring actually engages on real traffic
//    (dbBreaker's own success counter increases after an ordinary query)
//    without ever forcing the shared breaker open, since that would affect
//    every other test file's database access in this process.
//
// The ai.js aiBreaker wrap and the new uncaughtException process handler are
// verified by code inspection (mirrors the already-relied-upon
// predictions.js/unhandledRejection patterns exactly) and a real Docker boot
// check, not here — see the WP12 completion report for why a live test isn't
// a good fit for either (network-dependent provider calls; a process-level
// handler only registered in index.js's start(), which the test harness
// deliberately never invokes).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { CircuitBreaker } = require('../../src/lib/circuit-breaker');
const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { dbBreaker } = require('../../src/lib/circuit-breaker');

describe('WP12 — CircuitBreaker state machine', () => {
  it('starts CLOSED and allows requests through', () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 50 });
    assert.strictEqual(cb.state, 'CLOSED');
    assert.strictEqual(cb.allowRequest(), true);
  });

  it('opens after failureThreshold consecutive failures within the monitor window', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, cooldownMs: 50, monitorWindowMs: 60000 });
    const failing = () => Promise.reject(new Error('boom'));

    await assert.rejects(cb.exec(failing));
    await assert.rejects(cb.exec(failing));
    assert.strictEqual(cb.state, 'CLOSED', 'must stay closed below the threshold');
    await assert.rejects(cb.exec(failing));
    assert.strictEqual(cb.state, 'OPEN', 'must open once the threshold is reached');
  });

  it('fast-fails with a tagged circuitBreaker error while OPEN, without calling the function', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, cooldownMs: 10_000 });
    await assert.rejects(cb.exec(() => Promise.reject(new Error('boom'))));
    assert.strictEqual(cb.state, 'OPEN');

    let called = false;
    await assert.rejects(
      cb.exec(() => { called = true; return Promise.resolve('should not run'); }),
      (err) => {
        assert.strictEqual(err.circuitBreaker, true);
        assert.strictEqual(err.statusCode, 503);
        return true;
      }
    );
    assert.strictEqual(called, false, 'the wrapped function must not run while the circuit is open');
  });

  it('transitions to HALF_OPEN after cooldown and closes again on a successful probe', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, cooldownMs: 30 });
    await assert.rejects(cb.exec(() => Promise.reject(new Error('boom'))));
    assert.strictEqual(cb.state, 'OPEN');

    await new Promise((r) => setTimeout(r, 40));

    const result = await cb.exec(() => Promise.resolve('recovered'));
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(cb.state, 'CLOSED', 'a successful probe after cooldown must close the circuit');
  });

  it('reopens if the HALF_OPEN probe itself fails', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, cooldownMs: 30 });
    await assert.rejects(cb.exec(() => Promise.reject(new Error('boom'))));
    await new Promise((r) => setTimeout(r, 40));

    await assert.rejects(cb.exec(() => Promise.reject(new Error('still down'))));
    assert.strictEqual(cb.state, 'OPEN', 'a failed probe must reopen the circuit, not leave it half-open');
  });

  it('getStatus() reports accurate counters', async () => {
    const cb = new CircuitBreaker({ name: 'reporting-test', failureThreshold: 10 });
    await cb.exec(() => Promise.resolve('ok'));
    await assert.rejects(cb.exec(() => Promise.reject(new Error('boom'))));

    const status = cb.getStatus();
    assert.strictEqual(status.name, 'reporting-test');
    assert.strictEqual(status.totalSuccesses, 1);
    assert.strictEqual(status.totalFailures, 1);
    assert.strictEqual(status.state, 'CLOSED');
  });
});

describe('WP12 — dbBreaker is actually wired into real Prisma traffic', () => {
  it('an ordinary Prisma query increments dbBreaker\'s success counter (proves the $extends wiring engages)', async (t) => {
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return t.skip('No database available in this environment');

    const before = dbBreaker.getStatus().totalSuccesses;
    await prisma.organization.count();
    const after = dbBreaker.getStatus().totalSuccesses;

    assert.ok(after > before, 'dbBreaker.totalSuccesses must increase after a real query — previously nothing ever called dbBreaker at all');
  });
});

describe('WP12 — ai.js circuit-breaker wrap did not disturb existing pre-flight checks', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin, token;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();
    org = await createTestOrg(); // aiEnabled defaults to false — AI not configured
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    token = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('POST /ai/chat still returns AI_NOT_CONFIGURED before ever reaching the breaker-wrapped provider call', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: { message: 'hello' }
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().code, 'AI_NOT_CONFIGURED');
  });
});
