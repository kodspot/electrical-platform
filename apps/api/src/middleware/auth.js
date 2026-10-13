'use strict';

const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');
const { stripQuery } = require('../lib/log-redaction');
const { isModuleEnabled } = require('../services/module-policy');
const { getPermissionPolicy } = require('./permission-policy');
const { attachTenantContextFromUser, getTenantOrgId } = require('./tenant-context');

// JWT authentication — verifies token, attaches user to request
async function authenticateJWT(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // A worker token (workerId) or any token without userId is not a staff session:
    // refuse it before querying (findUnique with id: undefined throws). [F15]
    if (!decoded.userId) return reply.code(401).send({ error: 'Unauthorized' });

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, orgId: true, role: true, isActive: true, name: true, email: true, tokenInvalidBefore: true }
    });

    if (!user || !user.isActive) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Reject tokens issued before a password change
    if (user.tokenInvalidBefore && decoded.iat && decoded.iat < Math.floor(user.tokenInvalidBefore.getTime() / 1000)) {
      return reply.code(401).send({ error: 'Session expired. Please log in again.' });
    }

    // For org-scoped users, verify their org is still active
    if (user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { status: true }
      });
      if (!org || org.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'Organization is not active' });
      }
    }

    // SUPER_ADMIN org context: allow operating on any org via X-Org-Id header
    if (user.role === 'SUPER_ADMIN') {
      const targetOrgId = request.headers['x-org-id'];
      if (targetOrgId) {
        const org = await prisma.organization.findUnique({
          where: { id: targetOrgId },
          select: { id: true, status: true, name: true }
        });
        if (org && org.status === 'ACTIVE') {
          user.orgId = targetOrgId;
          user._saOrgSwitch = { orgId: org.id, orgName: org.name };
        }
      }
    }

    request.user = user;
    attachTenantContextFromUser(request, user);
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

/**
 * Register onResponse hook to audit-log every SuperAdmin org-context (X-Org-Id)
 * request — reads included, not just writes. A SuperAdmin "entering" an org via
 * this header is this platform's only impersonation-like mechanism, and browsing
 * an org's dashboard is almost entirely GET requests (tickets, workers,
 * attendance, PII) — excluding reads left the vast majority of a SuperAdmin's
 * cross-tenant access with no audit trail at all. [WP8]
 * Call once during server setup: registerSAuditHook(fastify)
 */
function registerSAuditHook(fastify) {
  fastify.addHook('onResponse', async (request) => {
    if (request.user?._saOrgSwitch) {
      const { orgId, orgName } = request.user._saOrgSwitch;
      // onResponse runs after the client already has the response, so awaiting
      // here costs no user-facing latency — but it does make this audit write
      // deterministic rather than a bare, trackable-nowhere fire-and-forget,
      // which matters for an audit log specifically (compliance record, not a
      // best-effort side effect like a notification). Still never throws.
      await prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'super_admin',
          actorId: request.user.id,
          action: request.method === 'GET' ? 'sa_org_context_read' : 'sa_org_context_write',
          entityType: 'Organization',
          entityId: orgId,
          // The path without its query: a URL here can carry a ?token= credential. [WP-A]
          newValue: { orgName, method: request.method, url: stripQuery(request.url) }
        }
      }).catch(() => {});
    }
  });
}

// Role check factory — SUPER_ADMIN bypasses all role checks
function requireRole(...roles) {
  return async function (request, reply) {
    if (!request.user) return reply.code(403).send({ error: 'Forbidden' });
    if (request.user.role === 'SUPER_ADMIN') return;
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

// Permission policy contract — standardized role + tenant + optional module checks
function requirePolicy(policyName, options = {}) {
  const policy = getPermissionPolicy(policyName);

  return async function (request, reply) {
    if (!request.user) return reply.code(403).send({ error: 'Forbidden' });

    const role = request.user.role;
    const roleAllowed = policy.roles.includes(role);
    const superAdminAllowed = policy.allowSuperAdmin && role === 'SUPER_ADMIN';

    if (!roleAllowed && !superAdminAllowed) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const requireOrgContext = options.requireOrgContext ?? policy.requireOrgContext;
    const orgId = getTenantOrgId(request);
    if (requireOrgContext && !orgId) {
      return reply.code(403).send({ error: 'No organization context' });
    }

    const moduleCode = options.moduleCode || null;
    if (moduleCode) {
      if (!orgId) return reply.code(403).send({ error: 'No organization context' });
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { enabledModules: true }
      });
      if (!isModuleEnabled(org, moduleCode)) {
        return reply.code(403).send({ error: 'Module not enabled for your organization' });
      }
    }
  };
}

// Module gating — verify org has the requested module enabled
function requireModule(moduleCode) {
  return async function (request, reply) {
    if (!request.user) return reply.code(403).send({ error: 'Forbidden' });
    if (request.user.role === 'SUPER_ADMIN') return; // SA bypasses
    const orgId = getTenantOrgId(request);
    if (!orgId) return reply.code(403).send({ error: 'No organization context' });
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { enabledModules: true }
    });
    if (!isModuleEnabled(org, moduleCode)) {
      return reply.code(403).send({ error: 'Module not enabled for your organization' });
    }
  };
}

module.exports = { authenticateJWT, requireRole, requirePolicy, requireModule, registerSAuditHook };
