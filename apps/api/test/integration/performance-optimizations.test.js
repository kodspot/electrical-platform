'use strict';

// Database-backed regression tests for WP11 (Performance, Query Optimization
// & Scalability Review). Covers two verified fixes:
//
// 1. services/assignment-resolver.js's getLocationAncestors/getLocationDescendants/
//    getLocationBreadcrumb used to walk the location hierarchy with one sequential
//    DB round trip per level (up to `maxDepth`, default 10). They now use a single
//    recursive CTE per call. getWorkerCoverageLocationIds (worker-auth.js) calls
//    getLocationDescendants on essentially every worker-app request, and
//    getAssignedSupervisorIds/getAssignedWorkerIds (both call getLocationAncestors)
//    run on every ticket creation and public complaint submission — this was the
//    hottest N+1 path in the app. Correctness must be identical to the old
//    per-level-query behavior; this file proves that across several hierarchy
//    shapes, plus a timing sanity check.
// 2. services/automation.js's NOTIFY_ASSIGNED_SUPERVISORS alert action used to
//    insert one Notification row per supervisor in a loop; it now uses a new
//    notifySupervisorIds() helper (services/notification-service.js) that
//    batches via a single createMany, matching the pattern already used for
//    NOTIFY_ASSIGNED_WORKERS.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const {
  getLocationAncestors,
  getLocationDescendants,
  getLocationBreadcrumb
} = require('../../src/services/assignment-resolver');
const { notifySupervisorIds } = require('../../src/services/notification-service');

describe('WP11 — location hierarchy queries (recursive CTE)', () => {
  let dbAvailable = false;
  const createdOrgIds = [];

  // A 5-level chain: root -> l1 -> l2 -> l3 -> leaf
  let org, root, l1, l2, l3, leaf;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    org = await createTestOrg();
    createdOrgIds.push(org.id);

    root = await createTestLocation(org.id, { name: '__wp1_test__ Root', type: 'BUILDING' });
    l1 = await createTestLocation(org.id, { name: '__wp1_test__ L1', type: 'FLOOR', parentId: root.id });
    l2 = await createTestLocation(org.id, { name: '__wp1_test__ L2', type: 'FLOOR', parentId: l1.id });
    l3 = await createTestLocation(org.id, { name: '__wp1_test__ L3', type: 'CORRIDOR', parentId: l2.id });
    leaf = await createTestLocation(org.id, { name: '__wp1_test__ Leaf', type: 'ROOM', parentId: l3.id });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('getLocationAncestors returns self + every ancestor, leaf to root', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ancestors = await getLocationAncestors(leaf.id);
    assert.deepStrictEqual(ancestors, [leaf.id, l3.id, l2.id, l1.id, root.id]);
  });

  it('getLocationAncestors on a root location (no parent) returns just itself', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ancestors = await getLocationAncestors(root.id);
    assert.deepStrictEqual(ancestors, [root.id]);
  });

  it('getLocationAncestors respects maxDepth', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    // maxDepth=2 means self + up to 2 ancestors = 3 entries max.
    const ancestors = await getLocationAncestors(leaf.id, 2);
    assert.strictEqual(ancestors.length, 3);
    assert.deepStrictEqual(ancestors, [leaf.id, l3.id, l2.id]);
  });

  it('getLocationDescendants returns every descendant, scoped to org and active locations', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const descendants = await getLocationDescendants(root.id, org.id);
    const ids = descendants.sort();
    assert.deepStrictEqual(ids, [l1.id, l2.id, l3.id, leaf.id].sort());
  });

  it('getLocationDescendants excludes inactive locations', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const inactiveChild = await createTestLocation(org.id, {
      name: '__wp1_test__ Inactive Child', type: 'ROOM', parentId: root.id, isActive: false
    });

    const descendants = await getLocationDescendants(root.id, org.id);
    assert.ok(!descendants.includes(inactiveChild.id), 'an inactive location must not appear as a descendant');
  });

  it('getLocationDescendants is scoped to the given orgId, not cross-org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const otherOrg = await createTestOrg();
    createdOrgIds.push(otherOrg.id);

    // A different org's root cannot see this org's descendants even by id collision chance.
    const descendants = await getLocationDescendants(root.id, otherOrg.id);
    assert.strictEqual(descendants.length, 0, 'querying descendants under the wrong orgId must return nothing');
  });

  it('getLocationBreadcrumb returns names ordered leaf to root', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const crumb = await getLocationBreadcrumb(leaf.id);
    assert.strictEqual(crumb, '__wp1_test__ Leaf, __wp1_test__ L3, __wp1_test__ L2, __wp1_test__ L1, __wp1_test__ Root');
  });

  it('a deep-chain ancestor lookup completes quickly (single round trip, not one per level)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const start = Date.now();
    await getLocationAncestors(leaf.id);
    const elapsed = Date.now() - start;
    // A single CTE round trip should comfortably finish in well under a
    // second even on a slow CI box; 10 sequential round trips over the old
    // per-level implementation would not reliably do so under load. This is
    // a coarse sanity check, not a strict perf assertion.
    assert.ok(elapsed < 1000, `expected a single round trip to be fast, took ${elapsed}ms`);
  });
});

describe('WP11 — notifySupervisorIds (batched notification writes)', () => {
  let dbAvailable = false;
  const createdOrgIds = [];

  let org, supA, supB, otherSup, location;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    org = await createTestOrg();
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);
    supA = await createTestUser(org.id, { role: 'SUPERVISOR' });
    supB = await createTestUser(org.id, { role: 'SUPERVISOR' });
    otherSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('creates a notification for exactly the given supervisor IDs, not every supervisor in the org', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    await notifySupervisorIds(org.id, [supA.id, supB.id], {
      type: 'alert_test',
      title: '__wp1_test__ Alert',
      body: 'test body',
      entityId: location.id
    });

    const notifs = await prisma.notification.findMany({
      where: { orgId: org.id, type: 'alert_test' }
    });
    const notifiedUserIds = notifs.map(n => n.userId).sort();
    assert.deepStrictEqual(notifiedUserIds, [supA.id, supB.id].sort());
    assert.ok(!notifiedUserIds.includes(otherSup.id), 'a supervisor not in the id list must not be notified');
  });

  it('is a no-op for an empty id list (no error, no rows)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const before_ = await prisma.notification.count({ where: { orgId: org.id, type: 'alert_empty_test' } });
    await notifySupervisorIds(org.id, [], { type: 'alert_empty_test', title: 'x' });
    const after_ = await prisma.notification.count({ where: { orgId: org.id, type: 'alert_empty_test' } });
    assert.strictEqual(after_, before_);
  });
});
