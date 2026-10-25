'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { localDateKey } = require('../lib/dates');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requirePolicy, requireModule } = require('../middleware/auth');

const VALID_CATEGORIES = [
  'Transformer', 'Panel Board', 'Generator', 'UPS', 'Motor',
  'Cable', 'Switch Gear', 'Capacitor Bank', 'Busbar', 'Meter',
  'Inverter', 'Battery Bank', 'Lighting Fixture', 'Earthing System',
  'Surge Protector', 'Relay', 'Contactor', 'Circuit Breaker', 'Other'
];

const ASSET_INCLUDE = {
  location: { select: { id: true, name: true, type: true } },
  _count: { select: { events: true, failures: true, images: true } }
};

const ASSET_DETAIL_INCLUDE = {
  location: { select: { id: true, name: true, type: true } },
  images: { orderBy: { createdAt: 'desc' } },
  _count: { select: { events: true, failures: true } }
};

const createAssetSchema = z.object({
  assetCode: z.string().min(1).max(50).trim(),
  name: z.string().min(1).max(200).trim(),
  category: z.string().min(1).max(100).trim(),
  locationId: z.string().uuid(),
  make: z.string().max(200).trim().optional(),
  model: z.string().max(200).trim().optional(),
  serialNo: z.string().max(200).trim().optional(),
  ratedCapacity: z.string().max(100).trim().optional(),
  description: z.string().max(2000).trim().optional(),
  status: z.enum(['OPERATIONAL', 'UNDER_MAINTENANCE', 'FAULTY', 'DECOMMISSIONED']).optional(),
  condition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'CRITICAL']).optional(),
  installDate: z.string().optional(),
  warrantyExpiry: z.string().optional(),
  nextMaintenanceDue: z.string().optional(),
  maintenanceCycleDays: z.number().int().min(1).max(3650).optional(),
  purchaseCost: z.number().min(0).optional(),
  metadata: z.record(z.string(), z.any()).optional()
});

// On edit, null clears the two numeric fields (the form sends null for a cleared one). [BUG-0021]
const updateAssetSchema = createAssetSchema.partial().extend({
  maintenanceCycleDays: z.number().int().min(1).max(3650).nullable().optional(),
  purchaseCost: z.number().min(0).nullable().optional()
});

async function assetRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('asset'));

  // ─── LIST ASSETS ──────────────────────────────────────────
  fastify.get('/assets', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { locationId, category, status, condition, search, page, limit, sort, active } = request.query;

    const where = { orgId };
    if (locationId) where.locationId = locationId;
    if (category) where.category = category;
    if (status) where.status = status;
    if (condition) where.condition = condition;
    if (active !== undefined) where.isActive = active === 'true';

    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { assetCode: { contains: search.trim(), mode: 'insensitive' } },
        { serialNo: { contains: search.trim(), mode: 'insensitive' } }
      ];
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    let orderBy = [{ createdAt: 'desc' }];
    if (sort === 'name') orderBy = [{ name: 'asc' }];
    if (sort === 'code') orderBy = [{ assetCode: 'asc' }];
    if (sort === 'category') orderBy = [{ category: 'asc' }, { name: 'asc' }];
    if (sort === 'status') orderBy = [{ status: 'asc' }, { name: 'asc' }];
    if (sort === 'location') orderBy = [{ location: { name: 'asc' } }, { name: 'asc' }];
    if (sort === 'maintenance') orderBy = [{ nextMaintenanceDue: 'asc' }];

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy, take, skip, include: ASSET_INCLUDE }),
      prisma.asset.count({ where })
    ]);

    // Stats aggregation
    const [statusCounts, conditionCounts, overdueMaintenance] = await Promise.all([
      prisma.asset.groupBy({ by: ['status'], where: { orgId, isActive: true }, _count: true }),
      prisma.asset.groupBy({ by: ['condition'], where: { orgId, isActive: true }, _count: true }),
      prisma.asset.count({
        where: {
          orgId, isActive: true,
          nextMaintenanceDue: { lt: new Date() },
          status: { not: 'DECOMMISSIONED' }
        }
      })
    ]);

    return {
      assets,
      total,
      pages: Math.ceil(total / take),
      stats: {
        byStatus: Object.fromEntries(statusCounts.map(s => [s.status, s._count])),
        byCondition: Object.fromEntries(conditionCounts.map(c => [c.condition, c._count])),
        overdueMaintenance
      }
    };
  });

  // ─── GET SINGLE ASSET ────────────────────────────────────
  fastify.get('/assets/:id', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request, reply) => {
    const asset = await prisma.asset.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: ASSET_DETAIL_INCLUDE
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });
    return asset;
  });

  // ─── CREATE ASSET ────────────────────────────────────────
  fastify.post('/assets', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const data = createAssetSchema.parse(request.body);
    const orgId = request.user.orgId;

    // Validate location belongs to org
    const location = await prisma.location.findFirst({
      where: { id: data.locationId, orgId, isActive: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found or inactive' });

    // Check unique asset code
    const dupCode = await prisma.asset.findFirst({
      where: { orgId, assetCode: data.assetCode }
    });
    if (dupCode) return reply.code(409).send({ error: 'Asset code already exists in this organization' });

    // Registering an asset, its INSTALLED event, and the audit-log entry must
    // all commit together — a partial write would leave an asset with no
    // installation event on its own timeline. [WP9]
    const asset = await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({
        data: {
          orgId,
          assetCode: data.assetCode,
          name: data.name,
          category: data.category,
          locationId: data.locationId,
          make: data.make || null,
          model: data.model || null,
          serialNo: data.serialNo || null,
          ratedCapacity: data.ratedCapacity || null,
          description: data.description || null,
          status: data.status || 'OPERATIONAL',
          condition: data.condition || 'GOOD',
          installDate: data.installDate ? new Date(data.installDate) : null,
          warrantyExpiry: data.warrantyExpiry ? new Date(data.warrantyExpiry) : null,
          nextMaintenanceDue: data.nextMaintenanceDue ? new Date(data.nextMaintenanceDue) : null,
          maintenanceCycleDays: data.maintenanceCycleDays || null,
          purchaseCost: data.purchaseCost ?? null, // 0 is a real cost (donated, free) [BUG-0049]
          metadata: data.metadata || null
        },
        include: ASSET_INCLUDE
      });

      // Create INSTALLED event
      await tx.assetEvent.create({
        data: {
          orgId,
          assetId: created.id,
          loggedById: request.user.id,
          type: 'INSTALLED',
          summary: 'Asset registered in system',
          statusAfter: created.status,
          conditionAfter: created.condition
        }
      });

      await tx.auditLog.create({
        data: {
          orgId,
          actorType: 'user',
          actorId: request.user.id,
          action: 'asset_created',
          entityType: 'Asset',
          entityId: created.id,
          newValue: { name: created.name, assetCode: created.assetCode, category: created.category }
        }
      });

      return created;
    });

    return reply.code(201).send(asset);
  });

  // ─── UPDATE ASSET ────────────────────────────────────────
  fastify.patch('/assets/:id', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const data = updateAssetSchema.parse(request.body);
    const orgId = request.user.orgId;

    const existing = await prisma.asset.findFirst({
      where: { id: request.params.id, orgId }
    });
    if (!existing) return reply.code(404).send({ error: 'Asset not found' });

    // Check unique asset code if changing
    if (data.assetCode && data.assetCode !== existing.assetCode) {
      const dup = await prisma.asset.findFirst({
        where: { orgId, assetCode: data.assetCode, id: { not: existing.id } }
      });
      if (dup) return reply.code(409).send({ error: 'Asset code already exists' });
    }

    // Validate location if changing
    if (data.locationId && data.locationId !== existing.locationId) {
      const loc = await prisma.location.findFirst({
        where: { id: data.locationId, orgId, isActive: true }
      });
      if (!loc) return reply.code(404).send({ error: 'Location not found or inactive' });
    }

    // A FAULTY asset with open failure records can't be manually marked
    // OPERATIONAL/UNDER_MAINTENANCE via this generic PATCH — that would make
    // the asset's own status contradict its still-open AssetFailure rows.
    // The correct path is resolving the failure(s) via PATCH
    // /asset-failures/:id, which already flips the asset's status back
    // correctly once none remain open. Decommissioning is exempt — it makes
    // open failures moot, not contradicted. [WP10]
    if (data.status && data.status !== existing.status && existing.status === 'FAULTY' && data.status !== 'FAULTY' && data.status !== 'DECOMMISSIONED') {
      const openFailures = await prisma.assetFailure.count({
        where: { assetId: existing.id, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } }
      });
      if (openFailures > 0) {
        return reply.code(409).send({
          error: `Cannot set status to ${data.status} — ${openFailures} failure(s) are still open. Resolve them via the asset failure record instead.`
        });
      }
    }

    const updateData = {};
    if (data.assetCode !== undefined) updateData.assetCode = data.assetCode;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.locationId !== undefined) updateData.locationId = data.locationId;
    if (data.make !== undefined) updateData.make = data.make || null;
    if (data.model !== undefined) updateData.model = data.model || null;
    if (data.serialNo !== undefined) updateData.serialNo = data.serialNo || null;
    if (data.ratedCapacity !== undefined) updateData.ratedCapacity = data.ratedCapacity || null;
    if (data.description !== undefined) updateData.description = data.description || null;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.condition !== undefined) updateData.condition = data.condition;
    if (data.installDate !== undefined) updateData.installDate = data.installDate ? new Date(data.installDate) : null;
    if (data.warrantyExpiry !== undefined) updateData.warrantyExpiry = data.warrantyExpiry ? new Date(data.warrantyExpiry) : null;
    if (data.nextMaintenanceDue !== undefined) updateData.nextMaintenanceDue = data.nextMaintenanceDue ? new Date(data.nextMaintenanceDue) : null;
    if (data.maintenanceCycleDays !== undefined) updateData.maintenanceCycleDays = data.maintenanceCycleDays || null;
    if (data.purchaseCost !== undefined) updateData.purchaseCost = data.purchaseCost ?? null;
    if (data.metadata !== undefined) updateData.metadata = data.metadata || null;

    // Track status/condition changes for auto-event
    const statusChanged = data.status && data.status !== existing.status;
    const conditionChanged = data.condition && data.condition !== existing.condition;
    const locationChanged = data.locationId && data.locationId !== existing.locationId;

    // The asset update, its auto-created event, and the audit-log entry must
    // all commit together — a partial write would leave a status/condition
    // change with no corresponding event on the asset's timeline. [WP9]
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.asset.update({
        where: { id: existing.id },
        data: updateData,
        include: ASSET_INCLUDE
      });

      // Auto-create event on significant changes
      if (statusChanged || conditionChanged || locationChanged) {
        let eventType = 'NOTE';
        let summary = 'Asset updated';
        if (locationChanged) { eventType = 'RELOCATED'; summary = 'Asset relocated'; }
        if (data.status === 'DECOMMISSIONED') { eventType = 'DECOMMISSIONED'; summary = 'Asset decommissioned'; }
        if (existing.status === 'DECOMMISSIONED' && data.status && data.status !== 'DECOMMISSIONED') {
          eventType = 'RECOMMISSIONED'; summary = 'Asset recommissioned';
        }

        await tx.assetEvent.create({
          data: {
            orgId,
            assetId: existing.id,
            loggedById: request.user.id,
            type: eventType,
            summary,
            statusBefore: statusChanged ? existing.status : null,
            statusAfter: statusChanged ? data.status : null,
            conditionBefore: conditionChanged ? existing.condition : null,
            conditionAfter: conditionChanged ? data.condition : null
          }
        });
      }

      await tx.auditLog.create({
        data: {
          orgId,
          actorType: 'user',
          actorId: request.user.id,
          action: 'asset_updated',
          entityType: 'Asset',
          entityId: existing.id,
          oldValue: { status: existing.status, condition: existing.condition },
          newValue: updateData
        }
      });

      return result;
    });

    return updated;
  });

  // ─── DELETE / DEACTIVATE ASSET ───────────────────────────
  fastify.delete('/assets/:id', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const asset = await prisma.asset.findFirst({
      where: { id: request.params.id, orgId },
      include: { _count: { select: { events: true, failures: true } } }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    // If asset has history, soft-deactivate. The status update and its
    // DECOMMISSIONED event must commit together — a partial write would
    // leave an asset deactivated with no record of why. [WP9]
    if (asset._count.events > 1 || asset._count.failures > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.asset.update({
          where: { id: asset.id },
          data: { isActive: false, status: 'DECOMMISSIONED' }
        });

        await tx.assetEvent.create({
          data: {
            orgId,
            assetId: asset.id,
            loggedById: request.user.id,
            type: 'DECOMMISSIONED',
            summary: 'Asset decommissioned and deactivated',
            statusBefore: asset.status,
            statusAfter: 'DECOMMISSIONED'
          }
        });
      });

      return { message: 'Asset decommissioned (has existing history)' };
    }

    // No history — hard delete, together with its audit-log entry. [WP9]
    await prisma.$transaction(async (tx) => {
      await tx.asset.delete({ where: { id: asset.id } });

      await tx.auditLog.create({
        data: {
          orgId,
          actorType: 'user',
          actorId: request.user.id,
          action: 'asset_deleted',
          entityType: 'Asset',
          entityId: asset.id,
          oldValue: { name: asset.name, assetCode: asset.assetCode }
        }
      });
    });

    return { message: 'Asset deleted' };
  });

  // ─── UPLOAD ASSET IMAGE ──────────────────────────────────
  fastify.post('/assets/:id/images', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const asset = await prisma.asset.findFirst({
      where: { id: request.params.id, orgId }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    const imageField = request.body.image;
    if (!imageField || !imageField.mimetype) {
      return reply.code(400).send({ error: 'Image file is required' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(imageField.mimetype)) {
      return reply.code(400).send({ error: 'Only JPG, PNG, WebP allowed' });
    }

    const buffer = await imageField.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.code(400).send({ error: 'Image too large (max 5MB)' });
    }
    if (!validateImageBuffer(buffer, imageField.mimetype)) {
      return reply.code(400).send({ error: 'Invalid image file' });
    }

    const caption = typeof request.body.caption === 'object' ? request.body.caption.value : (request.body.caption || null);
    const isPrimary = typeof request.body.isPrimary === 'object' ? request.body.isPrimary.value === 'true' : false;

    const url = await uploadToR2(buffer, imageField.mimetype, orgId);

    // If setting as primary, unset others
    if (isPrimary) {
      await prisma.assetImage.updateMany({
        where: { assetId: asset.id, isPrimary: true },
        data: { isPrimary: false }
      });
    }

    const img = await prisma.assetImage.create({
      data: { assetId: asset.id, imageUrl: url, caption, isPrimary }
    });

    // Update asset's imageUrl to primary
    if (isPrimary) {
      await prisma.asset.update({
        where: { id: asset.id },
        data: { imageUrl: url }
      });
    }

    return reply.code(201).send(img);
  });

  // ─── DELETE ASSET IMAGE ──────────────────────────────────
  fastify.delete('/assets/:assetId/images/:imageId', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const asset = await prisma.asset.findFirst({
      where: { id: request.params.assetId, orgId },
      select: { id: true }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    const image = await prisma.assetImage.findFirst({
      where: { id: request.params.imageId, assetId: asset.id }
    });
    if (!image) return reply.code(404).send({ error: 'Image not found' });

    await deleteFromR2(image.imageUrl);
    await prisma.assetImage.delete({ where: { id: image.id } });

    return { message: 'Image deleted' };
  });

  // ─── ASSET CATEGORIES ───────────────────────────────────
  fastify.get('/assets/categories', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request) => {
    const orgId = request.user.orgId;
    // Return hardcoded + custom categories used by org
    const usedCategories = await prisma.asset.findMany({
      where: { orgId },
      select: { category: true },
      distinct: ['category']
    });
    const used = usedCategories.map(c => c.category);
    const all = [...new Set([...VALID_CATEGORIES, ...used])].sort();
    return all;
  });

  // ─── ASSET SUMMARY FOR DASHBOARD ────────────────────────
  fastify.get('/assets/summary', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;

    const [total, operational, faulty, underMaintenance, decommissioned, openFailures, overdueMaintenance] = await Promise.all([
      prisma.asset.count({ where: { orgId, isActive: true } }),
      prisma.asset.count({ where: { orgId, isActive: true, status: 'OPERATIONAL' } }),
      prisma.asset.count({ where: { orgId, isActive: true, status: 'FAULTY' } }),
      prisma.asset.count({ where: { orgId, isActive: true, status: 'UNDER_MAINTENANCE' } }),
      prisma.asset.count({ where: { orgId, status: 'DECOMMISSIONED' } }),
      prisma.assetFailure.count({ where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } } }),
      prisma.asset.count({
        where: {
          orgId, isActive: true,
          nextMaintenanceDue: { lt: new Date() },
          status: { not: 'DECOMMISSIONED' }
        }
      })
    ]);

    return { total, operational, faulty, underMaintenance, decommissioned, openFailures, overdueMaintenance };
  });

  // ─── EXPORT CSV ──────────────────────────────────────────
  fastify.get('/assets/export', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { category, status, locationId } = request.query;

    const where = { orgId };
    if (category) where.category = category;
    if (status) where.status = status;
    if (locationId) where.locationId = locationId;

    const assets = await prisma.asset.findMany({
      where,
      orderBy: { assetCode: 'asc' },
      take: 5000,
      include: { location: { select: { name: true } } }
    });

    const csvGuard = (s) => {
      if (!s) return '';
      s = String(s);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const header = 'Asset Code,Name,Category,Location,Make,Model,Serial No,Rated Capacity,Status,Condition,Install Date,Warranty Expiry,Next Maintenance,Cycle (days),Purchase Cost';
    const rows = assets.map(a => [
      csvGuard(a.assetCode), csvGuard(a.name), csvGuard(a.category),
      csvGuard(a.location?.name), csvGuard(a.make), csvGuard(a.model),
      csvGuard(a.serialNo), csvGuard(a.ratedCapacity),
      csvGuard(a.status), csvGuard(a.condition),
      a.installDate ? new Date(a.installDate).toLocaleDateString('en-IN') : '',
      a.warrantyExpiry ? new Date(a.warrantyExpiry).toLocaleDateString('en-IN') : '',
      a.nextMaintenanceDue ? new Date(a.nextMaintenanceDue).toLocaleDateString('en-IN') : '',
      a.maintenanceCycleDays || '',
      a.purchaseCost || ''
    ].join(','));

    const csv = header + '\n' + rows.join('\n');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="assets-' + localDateKey() + '.csv"');
    return csv;
  });
}

module.exports = assetRoutes;
