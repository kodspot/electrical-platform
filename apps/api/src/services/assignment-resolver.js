'use strict';

const { prisma } = require('../lib/prisma');

/**
 * Location-aware assignment resolver.
 *
 * Walks up the location hierarchy to find workers/supervisors assigned
 * to a location or any of its ancestors.
 *
 * Example: Room 101 → Floor 1 → Boys Hostel
 *   If Electrician A is assigned to Boys Hostel (coverChildren=true),
 *   calling getAssignedWorkerIds('room-101-id') returns [Electrician A's id].
 */

/**
 * Build the ancestor chain for a location (self + parent + grandparent...).
 * Returns array of location IDs from leaf to root.
 *
 * A single recursive CTE, not one round trip per hierarchy level — this is
 * called on the ticket-creation and public-complaint hot paths (via
 * getAssignedWorkerIds/getAssignedSupervisorIds below), so a deep hierarchy
 * used to mean up to `maxDepth` sequential DB round trips per call. [WP11]
 */
async function getLocationAncestors(locationId, maxDepth = 10) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE ancestors AS (
      SELECT id, "parentId", 0 AS depth
      FROM "Location"
      WHERE id = ${locationId}
      UNION ALL
      SELECT l.id, l."parentId", a.depth + 1
      FROM "Location" l
      INNER JOIN ancestors a ON l.id = a."parentId"
      WHERE a.depth < ${maxDepth}
    )
    SELECT id FROM ancestors ORDER BY depth
  `;
  return rows.map(r => r.id);
}

/**
 * Get all descendant location IDs for a given location.
 * Returns flat array of child + grandchild + ... IDs.
 *
 * Single recursive CTE instead of one query per node in the descendant
 * subtree — this backs getWorkerCoverageLocationIds (worker-auth.js), which
 * runs on essentially every worker-app request (list/detail/pickup/resolve),
 * so this was the hottest N+1 path in the app. [WP11]
 */
async function getLocationDescendants(locationId, orgId, maxDepth = 10) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE descendants AS (
      SELECT id, "parentId", 0 AS depth
      FROM "Location"
      WHERE "parentId" = ${locationId} AND "orgId" = ${orgId} AND "isActive" = true
      UNION ALL
      SELECT l.id, l."parentId", d.depth + 1
      FROM "Location" l
      INNER JOIN descendants d ON l."parentId" = d.id
      WHERE l."orgId" = ${orgId} AND l."isActive" = true AND d.depth < ${maxDepth - 1}
    )
    SELECT id FROM descendants
  `;
  return rows.map(r => r.id);
}

/**
 * Get worker IDs assigned to a location, walking UP the hierarchy.
 *
 * Logic:
 * 1. Direct assignments to this exact location → always included
 * 2. Assignments to ancestor locations with coverChildren=true → included
 *
 * @param {string} locationId - The location where an event occurred
 * @param {string} orgId - Organization ID
 * @returns {Promise<string[]>} Array of unique active worker IDs
 */
async function getAssignedWorkerIds(locationId, orgId) {
  const ancestorIds = await getLocationAncestors(locationId);

  // Find all assignments for this location and its ancestors
  const assignments = await prisma.workerAssignment.findMany({
    where: {
      orgId,
      locationId: { in: ancestorIds },
      worker: { isActive: true }
    },
    select: {
      workerId: true,
      locationId: true,
      coverChildren: true
    }
  });

  const workerIds = new Set();

  for (const a of assignments) {
    if (a.locationId === locationId) {
      // Direct assignment — always matches
      workerIds.add(a.workerId);
    } else if (a.coverChildren) {
      // Ancestor assignment with coverChildren — matches
      workerIds.add(a.workerId);
    }
  }

  return [...workerIds];
}

/**
 * Get supervisor IDs assigned to a location, walking UP the hierarchy.
 * Same logic as getAssignedWorkerIds but for SupervisorAssignment.
 *
 * @param {string} locationId
 * @param {string} orgId
 * @returns {Promise<string[]>} Array of unique active supervisor user IDs
 */
async function getAssignedSupervisorIds(locationId, orgId) {
  const ancestorIds = await getLocationAncestors(locationId);

  const assignments = await prisma.supervisorAssignment.findMany({
    where: {
      orgId,
      locationId: { in: ancestorIds },
      supervisor: { isActive: true }
    },
    select: {
      supervisorId: true,
      locationId: true,
      coverChildren: true
    }
  });

  const supervisorIds = new Set();

  for (const a of assignments) {
    if (a.locationId === locationId) {
      supervisorIds.add(a.supervisorId);
    } else if (a.coverChildren) {
      supervisorIds.add(a.supervisorId);
    }
  }

  return [...supervisorIds];
}

/**
 * Build a full location breadcrumb string (Room 101, Floor 1, Boys Hostel).
 *
 * Single recursive CTE instead of one query per level — called on every
 * public complaint submission and alert/escalation evaluation. [WP11]
 * @param {string} locationId
 * @param {number} [maxDepth]
 * @returns {Promise<string>}
 */
async function getLocationBreadcrumb(locationId, maxDepth = 10) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE ancestors AS (
      SELECT id, name, "parentId", 0 AS depth
      FROM "Location"
      WHERE id = ${locationId}
      UNION ALL
      SELECT l.id, l.name, l."parentId", a.depth + 1
      FROM "Location" l
      INNER JOIN ancestors a ON l.id = a."parentId"
      WHERE a.depth < ${maxDepth - 1}
    )
    SELECT name FROM ancestors ORDER BY depth
  `;
  return rows.map(r => r.name).join(', ');
}

module.exports = {
  getLocationAncestors,
  getLocationDescendants,
  getAssignedWorkerIds,
  getAssignedSupervisorIds,
  getLocationBreadcrumb
};
