'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole, requireModule } = require('../middleware/auth');
const { evaluateEvent } = require('../services/automation');

const FAILURE_INCLUDE = {
  asset: { select: { id: true, assetCode: true, name: true, category: true, location: { select: { id: true, name: true } } } },
  loggedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
  images: { orderBy: { createdAt: 'desc' } },
  _count: { select: { images: true } }
};

const FAILURE_LIST_INCLUDE = {
  asset: { select: { id: true, assetCode: true, name: true, category: true } },
  loggedBy: { select: { id: true, name: true } },
  _count: { select: { images: true } }
};

const createFailureSchema = z.object({
  assetId: z.string().uuid(),
  title: z.string().min(1).max(300).trim(),
  description: z.string().max(5000).trim().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  failedAt: z.string().optional()
});

const updateFailureSchema = z.object({
  title: z.string().min(1).max(300).trim().optional(),
  description: z.string().max(5000).trim().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
  cause: z.string().max(2000).trim().optional(),
  resolution: z.string().max(5000).trim().optional(),
  resolutionCost: z.number().min(0).optional(),
  downtime: z.number().int().min(0).optional()
});

async function assetFailureRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('asset'));

  // ─── LIST FAILURES ────────────────────────────────────────
  fastify.get('/asset-failures', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { assetId, status, severity, page, limit, from, to, search, sort } = request.query;

    const where = { orgId };
    if (assetId) where.assetId = assetId;
    if (status) where.status = status;
    if (severity) where.severity = severity;

    if (search && search.trim()) {
      where.OR = [
        { title: { contains: search.trim(), mode: 'insensitive' } },
        { asset: { name: { contains: search.trim(), mode: 'insensitive' } } },
        { asset: { assetCode: { contains: search.trim(), mode: 'insensitive' } } }
      ];
    }

    if (from || to) {
      where.failedAt = {};
      if (from) where.failedAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.failedAt.lte = toDate;
      }
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    let orderBy = [{ failedAt: 'desc' }];
    if (sort === 'severity') orderBy = [{ severity: 'desc' }, { failedAt: 'desc' }];
    if (sort === 'oldest') orderBy = [{ failedAt: 'asc' }];
    if (sort === 'status') orderBy = [{ status: 'asc' }, { failedAt: 'desc' }];

    const [failures, total] = await Promise.all([
      prisma.assetFailure.findMany({
        where, orderBy, take, skip,
        include: FAILURE_LIST_INCLUDE
      }),
      prisma.assetFailure.count({ where })
    ]);

    // Stats
    const [bySeverity, byStatus] = await Promise.all([
      prisma.assetFailure.groupBy({
        by: ['severity'],
        where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
        _count: true
      }),
      prisma.assetFailure.groupBy({ by: ['status'], where: { orgId }, _count: true })
    ]);

    return {
      failures,
      total,
      pages: Math.ceil(total / take),
      stats: {
        bySeverity: Object.fromEntries(bySeverity.map(s => [s.severity, s._count])),
        byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count]))
      }
    };
  });

  // ─── GET SINGLE FAILURE ───────────────────────────────────
  fastify.get('/asset-failures/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const failure = await prisma.assetFailure.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: FAILURE_INCLUDE
    });
    if (!failure) return reply.code(404).send({ error: 'Failure record not found' });
    return failure;
  });

  // ─── REPORT FAILURE ───────────────────────────────────────
  fastify.post('/asset-failures', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const data = createFailureSchema.parse(request.body);
    const orgId = request.user.orgId;

    const asset = await prisma.asset.findFirst({
      where: { id: data.assetId, orgId }
    });
    if (!asset) return reply.code(404).send({ error: 'Asset not found' });

    const failure = await prisma.assetFailure.create({
      data: {
        orgId,
        assetId: asset.id,
        loggedById: request.user.id,
        title: data.title,
        description: data.description || null,
        severity: data.severity || 'MEDIUM',
        failedAt: data.failedAt ? new Date(data.failedAt) : new Date()
      },
      include: FAILURE_LIST_INCLUDE
    });

    // Update asset status to FAULTY
    await prisma.asset.update({
      where: { id: asset.id },
      data: { status: 'FAULTY' }
    });

    // Auto-create event on asset timeline
    await prisma.assetEvent.create({
      data: {
        orgId,
        assetId: asset.id,
        loggedById: request.user.id,
        type: 'NOTE',
        summary: 'Failure reported: ' + data.title,
        statusBefore: asset.status,
        statusAfter: 'FAULTY'
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'asset_failure_reported',
        entityType: 'AssetFailure',
        entityId: failure.id,
        newValue: { assetCode: asset.assetCode, title: data.title, severity: data.severity }
      }
    });

    // Fire-and-forget: alert evaluation
    evaluateEvent('ASSET_FAILURE_REPORTED', orgId, {
      entityType: 'failure', entityId: failure.id,
      severity: failure.severity, assetCode: asset.assetCode,
      failureTitle: data.title, description: data.description || '',
      locationId: asset.locationId, module: 'asset'
    }, fastify.log).catch(() => {});

    return reply.code(201).send(failure);
  });

  // ─── UPDATE FAILURE (Status transitions, resolution) ─────
  fastify.patch('/asset-failures/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const data = updateFailureSchema.parse(request.body);
    const orgId = request.user.orgId;

    const existing = await prisma.assetFailure.findFirst({
      where: { id: request.params.id, orgId },
      include: { asset: { select: { id: true, status: true, assetCode: true } } }
    });
    if (!existing) return reply.code(404).send({ error: 'Failure record not found' });

    // Validate status transitions
    const VALID_TRANSITIONS = {
      OPEN: ['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
      ACKNOWLEDGED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
      IN_PROGRESS: ['RESOLVED', 'CLOSED'],
      RESOLVED: ['CLOSED', 'OPEN'], // Can reopen
      CLOSED: ['OPEN'] // Can reopen
    };

    if (data.status && data.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(data.status)) {
        return reply.code(400).send({
          error: `Cannot transition from ${existing.status} to ${data.status}. Allowed: ${allowed.join(', ')}`
        });
      }
    }

    const updateData = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description || null;
    if (data.severity !== undefined) updateData.severity = data.severity;
    if (data.cause !== undefined) updateData.cause = data.cause || null;
    if (data.resolution !== undefined) updateData.resolution = data.resolution || null;
    if (data.resolutionCost !== undefined) updateData.resolutionCost = data.resolutionCost || null;
    if (data.downtime !== undefined) updateData.downtime = data.downtime;

    if (data.status) {
      updateData.status = data.status;

      if (data.status === 'ACKNOWLEDGED' && !existing.acknowledgedAt) {
        updateData.acknowledgedAt = new Date();
      }

      if (data.status === 'RESOLVED') {
        updateData.resolvedAt = new Date();
        updateData.resolvedById = request.user.id;

        // Auto-calculate downtime
        if (data.downtime == null) {
          const minutes = Math.floor((Date.now() - new Date(existing.failedAt).getTime()) / 60000);
          updateData.downtime = minutes;
        }

        // Check if asset has other open failures; if not, set back to OPERATIONAL
        const otherOpenFailures = await prisma.assetFailure.count({
          where: {
            assetId: existing.assetId,
            id: { not: existing.id },
            status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] }
          }
        });

        if (otherOpenFailures === 0) {
          await prisma.asset.update({
            where: { id: existing.assetId },
            data: { status: 'OPERATIONAL' }
          });

          await prisma.assetEvent.create({
            data: {
              orgId,
              assetId: existing.assetId,
              loggedById: request.user.id,
              type: 'REPAIRED',
              summary: 'Failure resolved: ' + (data.resolution || existing.title),
              statusBefore: 'FAULTY',
              statusAfter: 'OPERATIONAL',
              cost: data.resolutionCost || null
            }
          });
        }
      }

      if (data.status === 'OPEN' && (existing.status === 'RESOLVED' || existing.status === 'CLOSED')) {
        // Reopened — set asset back to FAULTY
        updateData.resolvedAt = null;
        updateData.resolvedById = null;
        updateData.resolution = null;
        updateData.downtime = null;

        await prisma.asset.update({
          where: { id: existing.assetId },
          data: { status: 'FAULTY' }
        });
      }
    }

    const updated = await prisma.assetFailure.update({
      where: { id: existing.id },
      data: updateData,
      include: FAILURE_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'asset_failure_updated',
        entityType: 'AssetFailure',
        entityId: existing.id,
        oldValue: { status: existing.status, severity: existing.severity },
        newValue: updateData
      }
    });

    return updated;
  });

  // ─── UPLOAD FAILURE IMAGE ────────────────────────────────
  fastify.post('/asset-failures/:id/images', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const failure = await prisma.assetFailure.findFirst({
      where: { id: request.params.id, orgId }
    });
    if (!failure) return reply.code(404).send({ error: 'Failure record not found' });

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
    const imageType = typeof request.body.type === 'object' ? request.body.type.value : (request.body.type || 'REPORT');

    const url = await uploadToR2(buffer, imageField.mimetype, orgId);

    const img = await prisma.assetFailureImage.create({
      data: { failureId: failure.id, imageUrl: url, caption, type: imageType }
    });

    return reply.code(201).send(img);
  });

  // ─── EXPORT CSV ──────────────────────────────────────────
  fastify.get('/asset-failures/export', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { status, severity, from, to } = request.query;

    const where = { orgId };
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (from || to) {
      where.failedAt = {};
      if (from) where.failedAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.failedAt.lte = toDate;
      }
    }

    const failures = await prisma.assetFailure.findMany({
      where,
      orderBy: { failedAt: 'desc' },
      take: 5000,
      include: {
        asset: { select: { assetCode: true, name: true, category: true, location: { select: { name: true } } } },
        loggedBy: { select: { name: true } },
        resolvedBy: { select: { name: true } }
      }
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

    const header = 'Asset Code,Asset Name,Category,Location,Title,Severity,Status,Cause,Failed At,Resolved At,Resolution,Cost,Downtime (min),Logged By,Resolved By';
    const rows = failures.map(f => [
      csvGuard(f.asset?.assetCode), csvGuard(f.asset?.name), csvGuard(f.asset?.category),
      csvGuard(f.asset?.location?.name), csvGuard(f.title), csvGuard(f.severity), csvGuard(f.status),
      csvGuard(f.cause),
      f.failedAt ? new Date(f.failedAt).toLocaleString('en-IN') : '',
      f.resolvedAt ? new Date(f.resolvedAt).toLocaleString('en-IN') : '',
      csvGuard(f.resolution), f.resolutionCost || '', f.downtime || '',
      csvGuard(f.loggedBy?.name), csvGuard(f.resolvedBy?.name)
    ].join(','));

    const csv = header + '\n' + rows.join('\n');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="asset-failures-' + new Date().toISOString().split('T')[0] + '.csv"');
    return csv;
  });
}

module.exports = assetFailureRoutes;
