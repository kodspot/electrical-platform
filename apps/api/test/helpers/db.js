'use strict';

/**
 * Test database helpers.
 *
 * The entity factories (createTestOrg, createTestUser, …) were extracted to the shared
 * scenario factory module (../../scenarios/factories) so tests and the seed/scenario
 * system build data through the same functions — one factory system. [platform-M3]
 * They are re-exported here unchanged, so every existing test import keeps working.
 *
 * This file keeps the test-only helpers that are NOT part of the shared factories:
 * `isDatabaseAvailable` (skip-gate for DB-backed tests) and `cleanupTestOrgs`.
 */

const { evaluateEffectiveTarget, readRootEnvText } = require('../setup/safety-rules');

// src/lib/prisma.js captures DATABASE_URL once, at first load. If this require is that first
// load, record the value it captures so the safety re-check judges exactly that URL. [QA-1]
const PRISMA_MODULE = require.resolve('../../src/lib/prisma');
const capturedUrl = require.cache[PRISMA_MODULE] ? undefined : process.env.DATABASE_URL;

const { prisma } = require('../../src/lib/prisma');
const factories = require('../../scenarios/factories');

// The preload (test/setup/safety.js) is the pre-flight; this is the gate actually in front of
// the database, so it also covers anything that changed the environment after the preload.
function assertSafeDatabaseTarget() {
  const hasUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const verdict = evaluateEffectiveTarget({
    env: process.env,
    dotenvText: hasUrl ? null : readRootEnvText(),
    capturedUrl
  });
  if (!verdict.ok) throw new Error(`[test safety] ${verdict.code}: ${verdict.message}`);
}

/**
 * Checks whether a real database is reachable, with a short bounded timeout so a
 * missing/unreachable Postgres instance fails fast instead of hanging the suite.
 * Integration tests that need real data should call this in a before() hook and
 * skip themselves (via t.skip()) when it resolves false, rather than fail confusingly.
 *
 * Throws instead — failing the calling file's tests rather than skipping them — when the
 * target is not a safe test database, or when CI=true and the database is unreachable:
 * in CI a skipped DB-backed test would otherwise look like a pass. [QA-1]
 */
async function isDatabaseAvailable(timeoutMs = 3000) {
  assertSafeDatabaseTarget();
  let reachable;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db check timeout')), timeoutMs))
    ]);
    reachable = true;
  } catch {
    reachable = false;
  }
  if (!reachable && process.env.CI === 'true') {
    throw new Error('CI=true: database unreachable — DB-backed tests must not skip in CI. Start the test database and check DATABASE_URL.');
  }
  return reachable;
}

/**
 * Deletes every Organization created by createTestOrg() (and, via schema-defined
 * onDelete: Cascade, everything that hangs off it — users, locations, tickets, etc.)
 * Safe to call even if some orgs were already removed by an individual test.
 */
async function cleanupTestOrgs(orgIds) {
  if (!orgIds || orgIds.length === 0) return;
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
}

module.exports = {
  ...factories,
  isDatabaseAvailable,
  cleanupTestOrgs
};
