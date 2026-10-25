'use strict';

const { prisma } = require('../lib/prisma');

// Audit actorType for an org-scoped action — must distinguish a SuperAdmin
// acting via X-Org-Id org-entry from a genuine org ADMIN/SUPERVISOR, or a
// SuperAdmin's write gets silently mislabeled as 'supervisor'. [WP8]
function auditActorType(role) {
  if (role === 'ADMIN') return 'admin';
  if (role === 'SUPER_ADMIN') return 'super_admin';
  return 'supervisor';
}

/**
 * One audit row for an action a signed-in staff member took in the org they are acting in
 * (request.user, set by authenticateJWT). Several changes left no row at all: templates,
 * rosters, attendance edits, alert-rule edits and acknowledgements, manual alert runs, ticket
 * creation. [PAR-10/13]
 * @param {{ user: { id: string, orgId: string, role: string } }} request
 * @param {{ action: string, entityType?: string, entityId?: string, oldValue?: object, newValue?: object }} row
 */
function auditStaffAction(request, { action, entityType, entityId, oldValue, newValue }) {
  return prisma.auditLog.create({
    data: {
      orgId: request.user.orgId,
      actorType: auditActorType(request.user.role),
      actorId: request.user.id,
      action,
      entityType,
      entityId,
      oldValue,
      newValue
    }
  });
}

/**
 * One audit row for something an account did to itself — signed in, changed or reset its
 * password or PIN — where the actor is the account (no request.user yet, or the same one).
 * No IP address or device is stored. [PAR-10/13]
 * @param {{ orgId: string|null, actorType: string, actorId: string, action: string, entityType: 'User'|'Worker' }} row
 */
function auditAccountAction({ orgId, actorType, actorId, action, entityType }) {
  return prisma.auditLog.create({ data: { orgId, actorType, actorId, action, entityType, entityId: actorId } });
}

module.exports = { auditActorType, auditStaffAction, auditAccountAction };
