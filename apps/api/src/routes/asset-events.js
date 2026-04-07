'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole, requireModule } = require('../middleware/auth');

const EVENT_INCLUDE = {
  asset: { select: { id: true, assetCode: true, name: true } },
  loggedBy: { select: { id: true, name: true } }
};

const createEventSchema = z.object({
  assetId: z.string().uuid(),
  type: z.enum(['INSTALLED', 'INSPECTED', 'MAINTAINED', 'REPAIRED', 'RELOCATED', 'DECOMMISSIONED', 'RECOMMISSIONED', 'NOTE']),
  summary: z.string().min(1).max(500).trim(),
  details: z.string().max(5000).trim().optional(),
  cost: z.number().min(0).optional(),
  statusAfter: z.enum(['OPERATIONAL', 'UNDER_MAINTENANCE', 'FAULTY', 'DECOMMISSIONED']).optional(),
  conditionAfter: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR', 'CRITICAL']).optional(),
  eventDate: z.string().optional()
});

async function assetEventRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('asset'));

  // ─── LIST EVENTS ──────────────────────────────────────────
  fastify.get('/asset-events', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { assetId, type, page, limit, from, to } = request.query;

    const where = { orgId };
    if (assetId) where.assetId = assetId;
    if (type) where.type = type;

    if (from || to) {
      where.eventDate = {};
      if (from) where.eventDate.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.eventDate.lte = toDate;
      }
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [events, total] = await Promise.all([
      prisma.assetEvent.findMany({
        where, orderBy: { eventDate: 'desc' }, take, skip,
        include: EVENT_INCLUDE
      }),
      prisma.assetEvent.count({ where })
    ]);

    return { events, total, pages: Math.ceil(total / take) };
  });

  // ─── GET SINGLE EVENT ─────────────────────────────────────
  fastify.get('/asset-events/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const event = await prisma.assetEvent.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: EVENT_INCLUDE
    });
    if (!event) return reply.code(404).send({ error: 'Event not found' });
    return event;
  });

  // ─── LOG EVENT ────────────────────────────────────────────
  fastify.post('/asset-events', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const data = createEventSchema.parse(request.body);
    const orgId = request.user.orgId;

    const asset = await prisma.asset.findFirst({
      where: { id: data.assetId, orgId }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    // Capture before-state
    const statusBefore = asset.status;
    const conditionBefore = asset.condition;

    // Create event
    const event = await prisma.assetEvent.create({
      data: {
        orgId,
        assetId: asset.id,
        loggedById: request.user.id,
        type: data.type,
        summary: data.summary,
        details: data.details || null,
        cost: data.cost || null,
        statusBefore,
        statusAfter: data.statusAfter || null,
        conditionBefore,
        conditionAfter: data.conditionAfter || null,
        eventDate: data.eventDate ? new Date(data.eventDate) : new Date()
      },
      include: EVENT_INCLUDE
    });

    // Update asset status/condition if specified
    const assetUpdate = {};
    if (data.statusAfter) assetUpdate.status = data.statusAfter;
    if (data.conditionAfter) assetUpdate.condition = data.conditionAfter;
    if (data.type === 'MAINTAINED' || data.type === 'REPAIRED') {
      assetUpdate.lastMaintenanceAt = new Date();
      // Auto-calculate next maintenance if cycle is set
      if (asset.maintenanceCycleDays) {
        const next = new Date();
        next.setDate(next.getDate() + asset.maintenanceCycleDays);
        assetUpdate.nextMaintenanceDue = next;
      }
    }

    if (Object.keys(assetUpdate).length > 0) {
      await prisma.asset.update({
        where: { id: asset.id },
        data: assetUpdate
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'asset_event_logged',
        entityType: 'AssetEvent',
        entityId: event.id,
        newValue: { assetCode: asset.assetCode, type: data.type, summary: data.summary }
      }
    });

    return reply.code(201).send(event);
  });

  // ─── TIMELINE FOR AN ASSET ───────────────────────────────
  fastify.get('/assets/:assetId/timeline', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const asset = await prisma.asset.findFirst({
      where: { id: request.params.assetId, orgId },
      select: { id: true }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    const take = Math.min(parseInt(request.query.limit) || 50, 200);

    // Merge events + failures into unified timeline
    const [events, failures] = await Promise.all([
      prisma.assetEvent.findMany({
        where: { assetId: asset.id },
        orderBy: { eventDate: 'desc' },
        take,
        include: { loggedBy: { select: { id: true, name: true } } }
      }),
      prisma.assetFailure.findMany({
        where: { assetId: asset.id },
        orderBy: { failedAt: 'desc' },
        take,
        include: { loggedBy: { select: { id: true, name: true } } }
      })
    ]);

    const timeline = [
      ...events.map(e => ({ kind: 'event', ...e, date: e.eventDate })),
      ...failures.map(f => ({ kind: 'failure', ...f, date: f.failedAt }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, take);

    return timeline;
  });
}

module.exports = assetEventRoutes;
