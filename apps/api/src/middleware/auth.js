'use strict';

const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');

// JWT authentication — verifies token, attaches user to request
async function authenticateJWT(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

/**
 * Register onResponse hook to audit-log SuperAdmin org-context switches.
 * Call once during server setup: registerSAuditHook(fastify)
 */
function registerSAuditHook(fastify) {
  fastify.addHook('onResponse', async (request) => {
    if (request.user?._saOrgSwitch && request.method !== 'GET') {
      const { orgId, orgName } = request.user._saOrgSwitch;
      prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'super_admin',
          actorId: request.user.id,
          action: 'sa_org_context_write',
          entityType: 'Organization',
          entityId: orgId,
          newValue: { orgName, method: request.method, url: request.url }
        }
      }).catch(() => {}); // fire-and-forget, never block response
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

// Module gating — verify org has the requested module enabled
function requireModule(moduleCode) {
  return async function (request, reply) {
    if (!request.user) return reply.code(403).send({ error: 'Forbidden' });
    if (request.user.role === 'SUPER_ADMIN') return; // SA bypasses
    const orgId = request.user.orgId;
    if (!orgId) return reply.code(403).send({ error: 'No organization context' });
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { enabledModules: true }
    });
    const modules = org?.enabledModules || ['ele'];
    if (!modules.includes(moduleCode)) {
      return reply.code(403).send({ error: 'Module not enabled for your organization' });
    }
  };
}

module.exports = { authenticateJWT, requireRole, requireModule, registerSAuditHook };
