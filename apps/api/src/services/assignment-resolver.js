'use strict';

const { prisma } = require('../lib/prisma');
const { ACTIVE_TICKET_STATUSES, VERIFY_PENDING_TICKET_STATUSES } = require('./ticket-status');
const { createNotification } = require('./notification-service');

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
 * Rank matching assignments into a stable, meaningful order and return the unique
 * person ids. Callers take [0] as "the" assignee (public.js / tickets.js auto-assignment),
 * so the order is part of the contract, not an accident of row order: [WP-H F2]
 *   1. a direct assignment to the location itself (depth 0),
 *   2. then the nearest ancestor with coverChildren (smaller depth first),
 *   3. then isPrimary first (worker assignments only — SupervisorAssignment has no such field),
 *   4. then the oldest assignment (createdAt), then assignment id as the final tie-break.
 * A person matched at several levels keeps their best (nearest) position.
 */
function rankAssignees(assignments, ancestorIds, locationId, personKey) {
  const depthOf = new Map(ancestorIds.map((id, depth) => [id, depth]));
  return [...new Set(
    assignments
      .filter((a) => a.locationId === locationId || a.coverChildren)
      .sort((a, b) =>
        depthOf.get(a.locationId) - depthOf.get(b.locationId) ||
        Number(b.isPrimary === true) - Number(a.isPrimary === true) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => a[personKey])
  )];
}

/**
 * Get worker IDs assigned to a location, walking UP the hierarchy.
 *
 * Logic:
 * 1. Direct assignments to this exact location → always included
 * 2. Assignments to ancestor locations with coverChildren=true → included
 * Ordered by rankAssignees() above.
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
      id: true,
      workerId: true,
      locationId: true,
      coverChildren: true,
      isPrimary: true,
      createdAt: true
    }
  });

  return rankAssignees(assignments, ancestorIds, locationId, 'workerId');
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
      id: true,
      supervisorId: true,
      locationId: true,
      coverChildren: true,
      createdAt: true
    }
  });

  return rankAssignees(assignments, ancestorIds, locationId, 'supervisorId');
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

/**
 * Where a supervisor's open tickets go when they stop covering them — deactivated, or moved
 * to another org: to the nearest active supervisor covering each ticket's location (the rule
 * a new complaint uses), else back to the pool (null). The supervisor is excluded explicitly,
 * so the plan can be made before the change that deactivates them is committed. Finished
 * work (resolved, closed, cancelled) keeps its assignee as history. [BUG-0037]
 * @returns {Promise<Array<{ id: string, title: string, to: string|null }>>}
 */
async function planTicketHandover(supervisorId, orgId) {
  const tickets = await prisma.ticket.findMany({
    where: { orgId, assignedToId: supervisorId, status: { in: [...ACTIVE_TICKET_STATUSES, ...VERIFY_PENDING_TICKET_STATUSES] } },
    select: { id: true, title: true, locationId: true }
  });
  const nextByLocation = new Map();
  const plan = [];
  for (const t of tickets) {
    if (!nextByLocation.has(t.locationId)) {
      const ids = (await getAssignedSupervisorIds(t.locationId, orgId)).filter((id) => id !== supervisorId);
      nextByLocation.set(t.locationId, ids[0] || null);
    }
    plan.push({ id: t.id, title: t.title, to: nextByLocation.get(t.locationId) });
  }
  return plan;
}

/** Tells each new assignee about the tickets handed to them (after the transaction commits). */
function notifyTicketHandover(orgId, plan) {
  for (const p of plan) {
    if (!p.to) continue;
    createNotification({ orgId, userId: p.to, type: 'ticket_reassigned', title: 'Ticket handed over to you', body: p.title, entityId: p.id }).catch(() => {});
  }
}

/** Applies a planTicketHandover plan inside the caller's transaction, one audit row per ticket. */
async function applyTicketHandover(tx, plan, { orgId, fromId, actorType, actorId, reason }) {
  for (const p of plan) {
    await tx.ticket.update({ where: { id: p.id }, data: { assignedToId: p.to } });
  }
  if (plan.length > 0) {
    await tx.auditLog.createMany({
      data: plan.map((p) => ({
        orgId, actorType, actorId, action: 'ticket_reassigned', entityType: 'Ticket', entityId: p.id,
        oldValue: { assignedToId: fromId }, newValue: { assignedToId: p.to, reason }
      }))
    });
  }
}

module.exports = {
  getLocationAncestors,
  getLocationDescendants,
  getAssignedWorkerIds,
  getAssignedSupervisorIds,
  getLocationBreadcrumb,
  planTicketHandover,
  applyTicketHandover,
  notifyTicketHandover
};
