'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole, requireModule } = require('../middleware/auth');

// Zod schemas
const templateItemSchema = z.object({
  label: z.string().min(1).max(100),
  checkKey: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'checkKey must be UPPER_SNAKE_CASE'),
  responseType: z.enum(['STATUS', 'READING', 'YES_NO']).default('STATUS'),
  unit: z.string().max(20).nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
  isRequired: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0)
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullish(),
  locationTypes: z.array(z.string().max(50)).default([]),
  isDefault: z.boolean().default(false),
  items: z.array(templateItemSchema).min(1).max(100)
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullish(),
  locationTypes: z.array(z.string().max(50)).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  items: z.array(templateItemSchema.extend({
    id: z.string().uuid().optional() // existing item id for updates
  })).min(1).max(100).optional()
});

async function templateRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('ele'));

  // ─── LIST TEMPLATES ────────────────────────────────────────
  fastify.get('/inspection-templates', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { active, locationType } = request.query;

    const where = { orgId };
    if (active !== undefined) where.isActive = active === 'true';

    const templates = await prisma.inspectionTemplate.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { inspections: true } }
      }
    });

    // If locationType filter requested, filter templates that match
    if (locationType) {
      return templates.filter(t =>
        t.locationTypes.length === 0 || t.locationTypes.includes(locationType)
      );
    }

    return templates;
  });

  // ─── GET SINGLE TEMPLATE ──────────────────────────────────
  fastify.get('/inspection-templates/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const template = await prisma.inspectionTemplate.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { inspections: true } }
      }
    });
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  // ─── CREATE TEMPLATE ──────────────────────────────────────
  fastify.post('/inspection-templates', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const data = createTemplateSchema.parse(request.body);
    const orgId = request.user.orgId;

    // Check duplicate name within org
    const existing = await prisma.inspectionTemplate.findFirst({
      where: { orgId, name: data.name }
    });
    if (existing) return reply.code(409).send({ error: 'Template with this name already exists' });

    // Check duplicate checkKeys within the items array
    const checkKeys = data.items.map(i => i.checkKey);
    if (new Set(checkKeys).size !== checkKeys.length) {
      return reply.code(400).send({ error: 'Duplicate checkKey values in items' });
    }

    // If setting as default, unset other defaults for this org
    if (data.isDefault) {
      await prisma.inspectionTemplate.updateMany({
        where: { orgId, isDefault: true },
        data: { isDefault: false }
      });
    }

    const template = await prisma.inspectionTemplate.create({
      data: {
        orgId,
        name: data.name,
        description: data.description,
        locationTypes: data.locationTypes,
        isDefault: data.isDefault,
        items: {
          create: data.items.map((item, idx) => ({
            label: item.label,
            checkKey: item.checkKey,
            responseType: item.responseType,
            unit: item.unit,
            minValue: item.minValue,
            maxValue: item.maxValue,
            isRequired: item.isRequired,
            sortOrder: item.sortOrder || idx
          }))
        }
      },
      include: {
        items: { orderBy: { sortOrder: 'asc' } }
      }
    });

    return reply.code(201).send(template);
  });

  // ─── UPDATE TEMPLATE ──────────────────────────────────────
  fastify.patch('/inspection-templates/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const data = updateTemplateSchema.parse(request.body);
    const orgId = request.user.orgId;

    const existing = await prisma.inspectionTemplate.findFirst({
      where: { id: request.params.id, orgId },
      include: { items: true, _count: { select: { inspections: true } } }
    });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    // Check name uniqueness if changing name
    if (data.name && data.name !== existing.name) {
      const dup = await prisma.inspectionTemplate.findFirst({
        where: { orgId, name: data.name, id: { not: existing.id } }
      });
      if (dup) return reply.code(409).send({ error: 'Template with this name already exists' });
    }

    // If setting as default, unset others
    if (data.isDefault && !existing.isDefault) {
      await prisma.inspectionTemplate.updateMany({
        where: { orgId, isDefault: true },
        data: { isDefault: false }
      });
    }

    // Build update payload
    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.locationTypes !== undefined) updateData.locationTypes = data.locationTypes;
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;

    // If items are updated and template has been used, bump version
    if (data.items && existing._count.inspections > 0) {
      updateData.version = existing.version + 1;
    }

    // Update items: replace-all strategy (delete old, create new)
    if (data.items) {
      const checkKeys = data.items.map(i => i.checkKey);
      if (new Set(checkKeys).size !== checkKeys.length) {
        return reply.code(400).send({ error: 'Duplicate checkKey values in items' });
      }

      await prisma.$transaction([
        prisma.inspectionTemplateItem.deleteMany({ where: { templateId: existing.id } }),
        prisma.inspectionTemplate.update({
          where: { id: existing.id },
          data: {
            ...updateData,
            items: {
              create: data.items.map((item, idx) => ({
                label: item.label,
                checkKey: item.checkKey,
                responseType: item.responseType,
                unit: item.unit,
                minValue: item.minValue,
                maxValue: item.maxValue,
                isRequired: item.isRequired,
                sortOrder: item.sortOrder || idx
              }))
            }
          }
        })
      ]);
    } else {
      await prisma.inspectionTemplate.update({
        where: { id: existing.id },
        data: updateData
      });
    }

    // Return updated template
    const updated = await prisma.inspectionTemplate.findUnique({
      where: { id: existing.id },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { inspections: true } }
      }
    });
    return updated;
  });

  // ─── DELETE TEMPLATE ──────────────────────────────────────
  fastify.delete('/inspection-templates/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;

    const template = await prisma.inspectionTemplate.findFirst({
      where: { id: request.params.id, orgId },
      include: { _count: { select: { inspections: true } } }
    });
    if (!template) return reply.code(404).send({ error: 'Template not found' });

    // If template has been used in inspections, soft-delete (deactivate) instead
    if (template._count.inspections > 0) {
      await prisma.inspectionTemplate.update({
        where: { id: template.id },
        data: { isActive: false, isDefault: false }
      });
      return { message: 'Template deactivated (has existing inspections)' };
    }

    // No inspections — hard delete (cascade removes items)
    await prisma.inspectionTemplate.delete({ where: { id: template.id } });
    return { message: 'Template deleted' };
  });

  // ─── DUPLICATE TEMPLATE ───────────────────────────────────
  fastify.post('/inspection-templates/:id/duplicate', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const source = await prisma.inspectionTemplate.findFirst({
      where: { id: request.params.id, orgId },
      include: { items: { orderBy: { sortOrder: 'asc' } } }
    });
    if (!source) return reply.code(404).send({ error: 'Template not found' });

    const copy = await prisma.inspectionTemplate.create({
      data: {
        orgId,
        name: `${source.name} (Copy)`,
        description: source.description,
        locationTypes: source.locationTypes,
        isDefault: false,
        items: {
          create: source.items.map(item => ({
            label: item.label,
            checkKey: item.checkKey,
            responseType: item.responseType,
            unit: item.unit,
            minValue: item.minValue,
            maxValue: item.maxValue,
            isRequired: item.isRequired,
            sortOrder: item.sortOrder
          }))
        }
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } }
    });

    return reply.code(201).send(copy);
  });

  // ─── RESOLVE TEMPLATE FOR LOCATION ────────────────────────
  // Used by supervisor UI to find the right template for a scanned location
  fastify.get('/inspection-templates/resolve', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { locationId } = request.query;
    if (!locationId) return reply.code(400).send({ error: 'locationId is required' });

    const location = await prisma.location.findFirst({
      where: { id: locationId, orgId },
      select: { type: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    // 1. Try location-type-specific template
    let template = await prisma.inspectionTemplate.findFirst({
      where: {
        orgId,
        isActive: true,
        locationTypes: { has: location.type }
      },
      orderBy: { sortOrder: 'asc' },
      include: { items: { orderBy: { sortOrder: 'asc' } } }
    });

    // 2. Fall back to default template
    if (!template) {
      template = await prisma.inspectionTemplate.findFirst({
        where: { orgId, isActive: true, isDefault: true },
        include: { items: { orderBy: { sortOrder: 'asc' } } }
      });
    }

    // 3. Fall back to any active template
    if (!template) {
      template = await prisma.inspectionTemplate.findFirst({
        where: { orgId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: { items: { orderBy: { sortOrder: 'asc' } } }
      });
    }

    if (!template) {
      return reply.code(404).send({ error: 'No active inspection template found. Ask your admin to create one.' });
    }

    return template;
  });
}

module.exports = templateRoutes;
