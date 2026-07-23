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

const { prisma } = require('../../src/lib/prisma');
const factories = require('../../scenarios/factories');

/**
 * Checks whether a real database is reachable, with a short bounded timeout so a
 * missing/unreachable Postgres instance fails fast instead of hanging the suite.
 * Integration tests that need real data should call this in a before() hook and
 * skip themselves (via t.skip()) when it resolves false, rather than fail confusingly.
 */
async function isDatabaseAvailable(timeoutMs = 3000) {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db check timeout')), timeoutMs))
    ]);
    return true;
  } catch {
    return false;
  }
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
