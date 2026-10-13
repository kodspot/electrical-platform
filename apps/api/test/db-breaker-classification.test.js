'use strict';

// F15 / BUG-0008: dbBreaker counted EVERY Prisma error as a database failure, so ordinary
// request errors (a validation error from an electrician's token on /api/images) opened
// it and took the whole platform to 503. Only infrastructure failures may count.
// Real Prisma error classes are used; nothing here touches a database.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { Prisma } = require('@prisma/client');

const { CircuitBreaker, dbBreaker, aiBreaker, isDbInfrastructureError } = require('../src/lib/circuit-breaker');

const v = Prisma.prismaVersion.client;
const validation = () => new Prisma.PrismaClientValidationError('Argument `id` must not be undefined', { clientVersion: v });
const known = (code) => new Prisma.PrismaClientKnownRequestError(`known ${code}`, { code, clientVersion: v });
const unknown = () => new Prisma.PrismaClientUnknownRequestError('unmapped database error', { clientVersion: v });
const init = () => new Prisma.PrismaClientInitializationError("Can't reach database server", v, 'P1001');
const panic = () => new Prisma.PrismaClientRustPanicError('engine panicked', v);
const net = (code) => Object.assign(new Error(`connect ${code}`), { code });

const reject = (err) => () => Promise.reject(err);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resetDbBreaker() {
  dbBreaker.state = 'CLOSED';
  dbBreaker.failures = [];
  dbBreaker.lastOpenedAt = 0;
}

describe('F15 — what counts as a database failure', () => {
  afterEach(resetDbBreaker);

  it('counts only infrastructure failures', () => {
    for (const err of [init(), panic(), known('P1001'), known('P1002'), known('P1008'), known('P1017'), known('P2024'),
      net('ECONNREFUSED'), net('ECONNRESET'), net('ETIMEDOUT')]) {
      assert.strictEqual(isDbInfrastructureError(err), true, `${err.name} ${err.code || ''} must count`);
    }
    const wrapped = Object.assign(new Error('fetch failed'), { cause: net('ECONNRESET') });
    assert.strictEqual(isDbInfrastructureError(wrapped), true, 'a network error carried as the cause counts');
  });

  it('does not count request-level errors (validation, P2002, P2025, other P2xxx, unknown request, plain errors)', () => {
    for (const err of [validation(), known('P2002'), known('P2025'), known('P2003'), known('P2034'), unknown(),
      new Error('boom'), new TypeError('x is undefined'), null, undefined]) {
      assert.strictEqual(isDbInfrastructureError(err), false, `${err && err.name} ${(err && err.code) || ''} must not count`);
    }
  });

  it('20 validation errors in a row leave dbBreaker CLOSED, and each still reaches the caller', async () => {
    const before = dbBreaker.getStatus().totalFailures;
    for (let i = 0; i < 20; i++) {
      await assert.rejects(dbBreaker.exec(reject(validation())), { name: 'PrismaClientValidationError' });
    }
    assert.strictEqual(dbBreaker.state, 'CLOSED');
    assert.strictEqual(dbBreaker.getStatus().totalFailures, before, 'none of them counted');
    assert.strictEqual(dbBreaker.getStatus().recentFailures, 0);
  });

  it('20 P2002 / P2025 / unknown-request errors leave dbBreaker CLOSED', async () => {
    for (let i = 0; i < 20; i++) {
      await assert.rejects(dbBreaker.exec(reject([known('P2002'), known('P2025'), unknown()][i % 3])));
    }
    assert.strictEqual(dbBreaker.state, 'CLOSED');
  });

  it('5 simulated P1001 errors still open dbBreaker, and it then fast-fails with 503', async () => {
    for (let i = 0; i < 5; i++) await assert.rejects(dbBreaker.exec(reject(known('P1001'))));
    assert.strictEqual(dbBreaker.state, 'OPEN');
    await assert.rejects(dbBreaker.exec(() => Promise.resolve('x')), (err) => err.circuitBreaker === true && err.statusCode === 503);
  });

  it('5 initialization errors, or 5 ECONNREFUSED, open it too', async () => {
    for (let i = 0; i < 5; i++) await assert.rejects(dbBreaker.exec(reject(init())));
    assert.strictEqual(dbBreaker.state, 'OPEN');
    resetDbBreaker();
    for (let i = 0; i < 5; i++) await assert.rejects(dbBreaker.exec(reject(net('ECONNREFUSED'))));
    assert.strictEqual(dbBreaker.state, 'OPEN');
  });

  it('ignored errors in between do not reset or pad the count: 4 P1001 + 10 validation + 1 P1001 opens', async () => {
    for (let i = 0; i < 4; i++) await assert.rejects(dbBreaker.exec(reject(known('P1001'))));
    for (let i = 0; i < 10; i++) await assert.rejects(dbBreaker.exec(reject(validation())));
    assert.strictEqual(dbBreaker.state, 'CLOSED');
    await assert.rejects(dbBreaker.exec(reject(known('P1001'))));
    assert.strictEqual(dbBreaker.state, 'OPEN');
  });
});

describe('F15 — HALF_OPEN recovery is unchanged for counted failures', () => {
  const breaker = () => new CircuitBreaker({ name: 't', failureThreshold: 2, cooldownMs: 30, isFailure: isDbInfrastructureError });

  it('OPEN → HALF_OPEN after cooldown → CLOSED on a successful probe', async () => {
    const cb = breaker();
    for (let i = 0; i < 2; i++) await assert.rejects(cb.exec(reject(known('P1017'))));
    assert.strictEqual(cb.state, 'OPEN');
    await sleep(40);
    assert.strictEqual(await cb.exec(() => Promise.resolve('ok')), 'ok');
    assert.strictEqual(cb.state, 'CLOSED');
  });

  it('a probe that fails with an infrastructure error reopens it', async () => {
    const cb = breaker();
    for (let i = 0; i < 2; i++) await assert.rejects(cb.exec(reject(known('P1017'))));
    await sleep(40);
    await assert.rejects(cb.exec(reject(known('P2024'))));
    assert.strictEqual(cb.state, 'OPEN');
    await assert.rejects(cb.exec(() => Promise.resolve('x')), (err) => err.statusCode === 503, 'still cooling down');
  });

  it('a probe that fails with an ignored error releases the probe slot: the next request probes', async () => {
    const cb = breaker();
    for (let i = 0; i < 2; i++) await assert.rejects(cb.exec(reject(known('P1001'))));
    await sleep(40);
    await assert.rejects(cb.exec(reject(validation())), { name: 'PrismaClientValidationError' });
    assert.notStrictEqual(cb.state, 'HALF_OPEN', 'must not wait in HALF_OPEN with no probe in flight');
    assert.strictEqual(await cb.exec(() => Promise.resolve('ok')), 'ok', 'the next request is let through as the probe');
    assert.strictEqual(cb.state, 'CLOSED');
  });
});

describe('F15 — other breakers keep counting every error', () => {
  it('the default classifier (aiBreaker) counts a plain error', async () => {
    const cb = new CircuitBreaker({ name: 'ai-like', failureThreshold: 1, cooldownMs: 10_000 });
    await assert.rejects(cb.exec(reject(new Error('provider 500'))));
    assert.strictEqual(cb.state, 'OPEN');
    assert.strictEqual(aiBreaker.isFailure(new Error('x')), true);
  });
});
