'use strict';

// Proves the cross-instance duplicate-execution guarantee src/lib/scheduler-lock.js
// exists to provide (WP6): with two independent PrismaClient connections — the
// realistic shape of two separate app instances, each with its own connection pool —
// racing for the same advisory lock, exactly one of them must actually run the job.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable (see
// test/helpers/db.js).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable } = require('../helpers/db');

describe('scheduler-lock cross-instance duplicate-execution protection', () => {
  let dbAvailable = false;
  let PrismaClient;
  let runExclusive, LOCK_KEYS;
  let prismaA, prismaB;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    ({ PrismaClient } = require('@prisma/client'));
    ({ runExclusive, LOCK_KEYS } = require('../../src/lib/scheduler-lock'));

    // Two separate clients = two separate connection pools, exactly like two real
    // app instances would have — not two calls sharing one pool, which wouldn't
    // prove anything about cross-instance safety.
    prismaA = new PrismaClient();
    prismaB = new PrismaClient();
  });

  after(async () => {
    if (!dbAvailable) return;
    await prismaA.$disconnect();
    await prismaB.$disconnect();
  });

  it('exactly one of two concurrent instances runs the job for the same lock key', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    let runCount = 0;
    const job = async (label) => {
      runCount++;
      await new Promise((r) => setTimeout(r, 300));
      return label;
    };

    const [resA, resB] = await Promise.all([
      runExclusive(prismaA, LOCK_KEYS.SCHEDULED_CHECKS, () => job('A')),
      runExclusive(prismaB, LOCK_KEYS.SCHEDULED_CHECKS, () => job('B'))
    ]);

    assert.strictEqual(runCount, 1, 'the job body must execute exactly once, not once per instance');
    const ranCount = [resA.ran, resB.ran].filter(Boolean).length;
    assert.strictEqual(ranCount, 1, 'exactly one of the two calls should report ran:true');
  });

  it('different lock keys do not block each other', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    let runCount = 0;
    const job = async () => { runCount++; };

    const [resA, resB] = await Promise.all([
      runExclusive(prismaA, LOCK_KEYS.SCHEDULED_CHECKS, job),
      runExclusive(prismaB, LOCK_KEYS.ESCALATION_CHECKS, job)
    ]);

    assert.strictEqual(runCount, 2, 'unrelated jobs must not contend for the same lock');
    assert.strictEqual(resA.ran, true);
    assert.strictEqual(resB.ran, true);
  });

  it('the lock is released after each run, so a later call for the same key can still run', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    let runCount = 0;
    const job = async () => { runCount++; };

    const first = await runExclusive(prismaA, LOCK_KEYS.IMAGE_CLEANUP, job);
    const second = await runExclusive(prismaA, LOCK_KEYS.IMAGE_CLEANUP, job);

    assert.strictEqual(runCount, 2, 'a completed run must not leak the lock and block subsequent runs');
    assert.strictEqual(first.ran, true);
    assert.strictEqual(second.ran, true);
  });

  it('a job that throws still releases the lock (transaction rolls back, not leaked)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    await assert.rejects(
      runExclusive(prismaA, LOCK_KEYS.GUEST_ANONYMIZATION, async () => {
        throw new Error('simulated job failure');
      })
    );

    // If the lock leaked, this second attempt would report ran:false.
    let ranAfterFailure = false;
    await runExclusive(prismaB, LOCK_KEYS.GUEST_ANONYMIZATION, async () => {
      ranAfterFailure = true;
    });
    assert.strictEqual(ranAfterFailure, true, 'a thrown job error must not leave the lock held');
  });
});
