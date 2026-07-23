'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requirePolicy } = require('../middleware/auth');
const {
  VALID_MODULES,
  normalizeModuleCode,
  normalizeIssueKey,
  humanizeIssueKey
} = require('../services/complaint-categories');

async function assertHostelScope(orgId, hostelLocationId) {
  if (!hostelLocationId) return null;

  const hostel = await prisma.location.findFirst({
    where: {
      id: hostelLocationId,
      orgId,
      type: 'HOSTEL'
    },
    select: { id: true, name: true, type: true }
  });

  return hostel || null;
}

async function findDuplicateCategory({ orgId, module, key, hostelLocationId, excludeId = null }) {
  return prisma.complaintCategory.findFirst({
    where: {
      orgId,
      module,
      key,
      hostelLocationId: hostelLocationId || null,
      ...(excludeId ? { id: { not: excludeId } } : {})
    },
    select: { id: true }
  });
}

async function complaintCategoryRoutes(fastify) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requirePolicy('ORG_ADMIN'));

  // ── List complaint categories ──
  fastify.get('/complaint-categories', async (request, reply) => {
    const orgId = request.user.orgId;
    const schema = z.object({
      module: z.string().optional(),
      includeInactive: z.string().optional(),
      hostelLocationId: z.string().optional()
    });

    const query = schema.parse(request.query || {});

    const where = { orgId };

    if (query.module) {
      const normalized = normalizeModuleCode(query.module);
      if (VALID_MODULES.indexOf(normalized) === -1) {
        return reply.code(400).send({ error: 'Invalid module' });
      }
      where.module = normalized;
    }

    if (query.includeInactive !== 'true') {
      where.isActive = true;
    }

    if (query.hostelLocationId) {
      if (query.hostelLocationId === 'global') {
        where.hostelLocationId = null;
      } else {
        const hostel = await assertHostelScope(orgId, query.hostelLocationId);
        if (!hostel) return reply.code(400).send({ error: 'Invalid hostel scope' });
        where.hostelLocationId = hostel.id;
      }
    }

    const categories = await prisma.complaintCategory.findMany({
      where,
      orderBy: [{ module: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        hostelLocation: { select: { id: true, name: true, type: true } }
      }
    });

    return { categories };
  });

  // ── Create complaint category ──
  fastify.post('/complaint-categories', async (request, reply) => {
    const orgId = request.user.orgId;

    const schema = z.object({
      name: z.string().min(1).max(120).trim(),
      module: z.enum(VALID_MODULES).default('ele'),
      key: z.string().max(80).optional(),
      description: z.string().max(500).optional().nullable(),
      sortOrder: z.number().int().min(0).max(999).default(0),
      isActive: z.boolean().default(true),
      hostelLocationId: z.string().uuid().optional().nullable()
    });

    const input = schema.parse(request.body || {});
    const moduleCode = normalizeModuleCode(input.module);
    const issueKey = normalizeIssueKey(input.key || input.name);

    if (!issueKey) {
      return reply.code(400).send({ error: 'Unable to derive category key. Provide a valid name or key.' });
    }

    let hostel = null;
    if (input.hostelLocationId) {
      hostel = await assertHostelScope(orgId, input.hostelLocationId);
      if (!hostel) return reply.code(400).send({ error: 'Invalid hostel scope' });
    }

    const duplicate = await findDuplicateCategory({
      orgId,
      module: moduleCode,
      key: issueKey,
      hostelLocationId: hostel ? hostel.id : null
    });

    if (duplicate) {
      return reply.code(409).send({ error: 'A category with this key already exists in the selected scope.' });
    }

    const category = await prisma.complaintCategory.create({
      data: {
        orgId,
        module: moduleCode,
        key: issueKey,
        name: input.name,
        description: input.description || null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        hostelLocationId: hostel ? hostel.id : null,
        createdById: request.user.id,
        updatedById: request.user.id
      },
      include: {
        hostelLocation: { select: { id: true, name: true, type: true } }
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'complaint_category_created',
        entityType: 'ComplaintCategory',
        entityId: category.id,
        newValue: {
          module: category.module,
          key: category.key,
          name: category.name,
          hostelLocationId: category.hostelLocationId
        }
      }
    });

    return reply.code(201).send(category);
  });

  // ── Update complaint category ──
  fastify.patch('/complaint-categories/:id', async (request, reply) => {
    const orgId = request.user.orgId;

    const schema = z.object({
      name: z.string().min(1).max(120).trim().optional(),
      module: z.enum(VALID_MODULES).optional(),
      key: z.string().max(80).optional(),
      description: z.string().max(500).optional().nullable(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      isActive: z.boolean().optional(),
      hostelLocationId: z.union([z.string().uuid(), z.literal('global'), z.null()]).optional()
    });

    const input = schema.parse(request.body || {});

    const existing = await prisma.complaintCategory.findFirst({
      where: { id: request.params.id, orgId }
    });

    if (!existing) return reply.code(404).send({ error: 'Category not found' });

    let nextHostelLocationId = existing.hostelLocationId;
    if (input.hostelLocationId !== undefined) {
      if (input.hostelLocationId === 'global' || input.hostelLocationId === null) {
        nextHostelLocationId = null;
      } else {
        const hostel = await assertHostelScope(orgId, input.hostelLocationId);
        if (!hostel) return reply.code(400).send({ error: 'Invalid hostel scope' });
        nextHostelLocationId = hostel.id;
      }
    }

    const nextModule = input.module ? normalizeModuleCode(input.module) : existing.module;
    const nextName = input.name !== undefined ? input.name : existing.name;
    const nextKey = normalizeIssueKey(input.key !== undefined ? input.key : input.name !== undefined ? input.name : existing.key);

    if (!nextKey) {
      return reply.code(400).send({ error: 'Unable to derive category key. Provide a valid name or key.' });
    }

    const duplicate = await findDuplicateCategory({
      orgId,
      module: nextModule,
      key: nextKey,
      hostelLocationId: nextHostelLocationId,
      excludeId: existing.id
    });

    if (duplicate) {
      return reply.code(409).send({ error: 'A category with this key already exists in the selected scope.' });
    }

    const updateData = {
      module: nextModule,
      key: nextKey,
      name: nextName,
      updatedById: request.user.id
    };

    if (input.description !== undefined) updateData.description = input.description;
    if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;
    if (input.hostelLocationId !== undefined) updateData.hostelLocationId = nextHostelLocationId;

    const updated = await prisma.complaintCategory.update({
      where: { id: existing.id },
      data: updateData,
      include: {
        hostelLocation: { select: { id: true, name: true, type: true } }
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'complaint_category_updated',
        entityType: 'ComplaintCategory',
        entityId: existing.id,
        oldValue: {
          module: existing.module,
          key: existing.key,
          name: existing.name,
          isActive: existing.isActive,
          hostelLocationId: existing.hostelLocationId
        },
        newValue: {
          module: updated.module,
          key: updated.key,
          name: updated.name,
          isActive: updated.isActive,
          hostelLocationId: updated.hostelLocationId
        }
      }
    });

    return updated;
  });

  // ── Delete complaint category ──
  fastify.delete('/complaint-categories/:id', async (request, reply) => {
    const orgId = request.user.orgId;
    const force = request.query.force === 'true';

    const existing = await prisma.complaintCategory.findFirst({
      where: { id: request.params.id, orgId }
    });

    if (!existing) return reply.code(404).send({ error: 'Category not found' });

    const usageCount = await prisma.ticket.count({
      where: {
        orgId,
        module: existing.module,
        issueType: existing.key
      }
    });

    if (usageCount > 0 && !force) {
      return reply.code(409).send({
        error: 'Category is used in existing complaints. Disable it instead, or delete with force=true.',
        usageCount
      });
    }

    await prisma.complaintCategory.delete({ where: { id: existing.id } });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'complaint_category_deleted',
        entityType: 'ComplaintCategory',
        entityId: existing.id,
        oldValue: {
          module: existing.module,
          key: existing.key,
          name: existing.name,
          hostelLocationId: existing.hostelLocationId,
          usageCount
        }
      }
    });

    return {
      success: true,
      deletedId: existing.id,
      deletedLabel: existing.name || humanizeIssueKey(existing.key)
    };
  });
}

module.exports = complaintCategoryRoutes;
