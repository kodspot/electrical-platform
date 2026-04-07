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
 */
async function getLocationAncestors(locationId, maxDepth = 10) {
  const chain = [locationId];
  let currentId = locationId;

  for (let i = 0; i < maxDepth; i++) {
    const loc = await prisma.location.findUnique({
      where: { id: currentId },
      select: { parentId: true }
    });
    if (!loc || !loc.parentId) break;
    chain.push(loc.parentId);
    currentId = loc.parentId;
  }

  return chain;
}

/**
 * Get all descendant location IDs for a given location.
 * Returns flat array of child + grandchild + ... IDs.
 */
async function getLocationDescendants(locationId, orgId, maxDepth = 10) {
  const descendants = [];
  const visited = new Set();

  async function walkChildren(parentId, depth) {
    if (depth >= maxDepth || visited.has(parentId)) return;
    visited.add(parentId);
    const children = await prisma.location.findMany({
      where: { parentId, orgId, isActive: true },
      select: { id: true }
    });
    for (const child of children) {
      descendants.push(child.id);
      await walkChildren(child.id, depth + 1);
    }
  }

  await walkChildren(locationId, 0);
  return descendants;
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
 * @param {string} locationId
 * @returns {Promise<string>}
 */
async function getLocationBreadcrumb(locationId) {
  const parts = [];
  let currentId = locationId;

  for (let i = 0; i < 10; i++) {
    const loc = await prisma.location.findUnique({
      where: { id: currentId },
      select: { name: true, parentId: true }
    });
    if (!loc) break;
    parts.push(loc.name);
    if (!loc.parentId) break;
    currentId = loc.parentId;
  }

  return parts.join(', ');
}

module.exports = {
  getLocationAncestors,
  getLocationDescendants,
  getAssignedWorkerIds,
  getAssignedSupervisorIds,
  getLocationBreadcrumb
};
