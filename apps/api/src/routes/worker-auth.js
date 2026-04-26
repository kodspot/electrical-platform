'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST } = require('../lib/security');
const { loginRateLimit } = require('../middleware/rateLimits');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { getLocationDescendants } = require('../services/assignment-resolver');
const { notifyAdmins, createNotification } = require('./notifications');

// ── Worker JWT Authentication Middleware ──

async function authenticateWorkerJWT(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.workerId) return reply.code(401).send({ error: 'Unauthorized' });

    const worker = await prisma.worker.findUnique({
      where: { id: decoded.workerId },
      select: { id: true, orgId: true, name: true, employeeId: true, phone: true, isActive: true, tokenInvalidBefore: true }
    });

    if (!worker || !worker.isActive) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (worker.tokenInvalidBefore && decoded.iat && decoded.iat < Math.floor(worker.tokenInvalidBefore.getTime() / 1000)) {
      return reply.code(401).send({ error: 'Session expired. Please log in again.' });
    }

    // Verify org is active
    const org = await prisma.organization.findUnique({
      where: { id: worker.orgId },
      select: { status: true }
    });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(403).send({ error: 'Organization is not active' });
    }

    request.worker = worker;
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

async function workerAuthRoutes(fastify) {

  async function getWorkerCoverageLocationIds(workerId, orgId) {
    const assignments = await prisma.workerAssignment.findMany({
      where: { workerId, orgId },
      select: { locationId: true, coverChildren: true }
    });
    const ids = new Set();
    for (const a of assignments) {
      ids.add(a.locationId);
      if (a.coverChildren) {
        const childIds = await getLocationDescendants(a.locationId, orgId);
        for (const cid of childIds) ids.add(cid);
      }
    }
    return [...ids];
  }

  async function processWorkerResolveImage(request, orgId) {
    const imageFile = request.body.image;
    if (!imageFile || !imageFile.mimetype) return null;
    const file = Array.isArray(imageFile) ? imageFile[0] : imageFile;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) throw new Error('Invalid image type. Use JPEG, PNG or WebP.');
    const buffer = await file.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) throw new Error('Image too large. Max 5MB.');
    if (!validateImageBuffer(buffer, file.mimetype)) throw new Error('Invalid image file');
    return uploadToR2(buffer, file.mimetype, orgId);
  }

  // ── Worker Login (employeeId + PIN) ──
  fastify.post('/auth/worker-login', {
    config: { rateLimit: loginRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      orgSlug: z.string().min(1).max(100).trim(),
      employeeId: z.string().min(1).max(50).trim(),
      pin: z.string().min(6).max(6).regex(/^\d+$/, 'PIN must be exactly 6 digits')
    });

    let data;
    try { data = schema.parse(request.body); } catch (err) {
      return reply.code(400).send({ error: 'Invalid input', details: err.errors });
    }

    // Find org by slug
    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
      select: { id: true, name: true, status: true }
    });
    if (!org || org.status !== 'ACTIVE') {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Find worker by employeeId in org
    const worker = await prisma.worker.findFirst({
      where: { orgId: org.id, employeeId: data.employeeId, isActive: true },
      select: { id: true, orgId: true, name: true, employeeId: true, phone: true, pinHash: true }
    });
    if (!worker || !worker.pinHash) {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const pinValid = await bcrypt.compare(data.pin, worker.pinHash);
    if (!pinValid) {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { workerId: worker.id, orgId: worker.orgId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return {
      token,
      worker: {
        id: worker.id,
        name: worker.name,
        employeeId: worker.employeeId,
        phone: worker.phone
      },
      org: { id: org.id, name: org.name }
    };
  });

  // ── Worker Profile ──
  fastify.get('/auth/worker-me', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const worker = await prisma.worker.findUnique({
      where: { id: request.worker.id },
      select: {
        id: true, name: true, employeeId: true, phone: true, email: true,
        department: true, designation: true, orgId: true
      }
    });
    const org = await prisma.organization.findUnique({
      where: { id: worker.orgId },
      select: { id: true, name: true, slug: true }
    });
    return { worker, org };
  });

  // ── Worker Change PIN ──
  fastify.patch('/auth/worker-pin', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const schema = z.object({
      currentPin: z.string().min(6).max(6).regex(/^\d+$/),
      newPin: z.string().min(6).max(6).regex(/^\d+$/, 'PIN must be exactly 6 digits')
    });

    let data;
    try { data = schema.parse(request.body); } catch (err) {
      return reply.code(400).send({ error: 'Invalid input', details: err.errors });
    }

    const worker = await prisma.worker.findUnique({
      where: { id: request.worker.id },
      select: { pinHash: true }
    });
    if (!worker || !worker.pinHash) {
      return reply.code(400).send({ error: 'PIN not set' });
    }

    const valid = await bcrypt.compare(data.currentPin, worker.pinHash);
    if (!valid) return reply.code(401).send({ error: 'Current PIN is incorrect' });

    const newPinHash = await bcrypt.hash(data.newPin, BCRYPT_COST);
    await prisma.worker.update({
      where: { id: request.worker.id },
      data: { pinHash: newPinHash, tokenInvalidBefore: new Date() }
    });

    return { success: true };
  });

  // ── Worker Notifications ──

  fastify.get('/worker/notifications/unread-count', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const count = await prisma.notification.count({
      where: { workerId: request.worker.id, isRead: false }
    });
    return { count };
  });

  fastify.get('/worker/notifications', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit) || 20, 50);
    const offset = parseInt(request.query.offset) || 0;

    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { workerId: request.worker.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      }),
      prisma.notification.count({ where: { workerId: request.worker.id } }),
      prisma.notification.count({ where: { workerId: request.worker.id, isRead: false } })
    ]);

    return { notifications, total, unread };
  });

  fastify.patch('/worker/notifications/read-all', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    await prisma.notification.updateMany({
      where: { workerId: request.worker.id, isRead: false },
      data: { isRead: true }
    });
    return { success: true };
  });

  fastify.patch('/worker/notifications/:id/read', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const notif = await prisma.notification.findFirst({
      where: { id: request.params.id, workerId: request.worker.id }
    });
    if (!notif) return reply.code(404).send({ error: 'Not found' });
    await prisma.notification.update({ where: { id: notif.id }, data: { isRead: true } });
    return { success: true };
  });

  fastify.delete('/worker/notifications/:id', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const notif = await prisma.notification.findFirst({
      where: { id: request.params.id, workerId: request.worker.id }
    });
    if (!notif) return reply.code(404).send({ error: 'Not found' });
    await prisma.notification.delete({ where: { id: notif.id } });
    return { success: true };
  });

  // ── Electrician (Worker) Tickets ──

  fastify.get('/worker/tickets', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const limit = Math.min(parseInt(request.query.limit, 10) || 50, 100);
    const page = Math.max(parseInt(request.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) {
      return { tickets: [], total: 0, page, pages: 0, stats: { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 } };
    }

    const statuses = request.query.status
      ? String(request.query.status).split(',').map(s => s.trim()).filter(Boolean)
      : ['OPEN', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFY'];

    const where = {
      orgId,
      locationId: { in: locationIds },
      status: statuses.length > 1 ? { in: statuses } : statuses[0]
    };

    const [tickets, total, grouped] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          location: { select: { id: true, name: true, type: true } },
          assignedTo: { select: { id: true, name: true } },
          resolvedWorkers: { select: { id: true, name: true } }
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.groupBy({
        by: ['status'],
        where: { orgId, locationId: { in: locationIds } },
        _count: true
      })
    ]);

    const stats = { OPEN: 0, IN_PROGRESS: 0, RESOLVED_PENDING_VERIFY: 0, RESOLVED: 0, CLOSED: 0 };
    for (const g of grouped) stats[g.status] = (stats[g.status] || 0) + g._count;

    return { tickets, total, page, pages: Math.ceil(total / limit), stats };
  });

  fastify.get('/worker/tickets/:id', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) return reply.code(404).send({ error: 'Ticket not found' });

    const ticket = await prisma.ticket.findFirst({
      where: { id: request.params.id, orgId, locationId: { in: locationIds } },
      include: {
        location: { select: { id: true, name: true, type: true } },
        assignedTo: { select: { id: true, name: true } },
        resolvedWorkers: { select: { id: true, name: true } }
      }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    return ticket;
  });

  fastify.post('/worker/tickets/:id/resolve', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) return reply.code(403).send({ error: 'No assigned locations' });

    const ticket = await prisma.ticket.findFirst({
      where: { id: request.params.id, orgId, locationId: { in: locationIds } },
      include: { resolvedWorkers: { select: { id: true } } }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status === 'CLOSED') return reply.code(400).send({ error: 'Ticket is already closed' });

    const fieldValue = (f) => {
      if (f == null) return undefined;
      if (typeof f === 'object' && 'value' in f) return f.value;
      return f;
    };

    const note = fieldValue(request.body?.note)?.trim() || null;
    let resolvedImageUrl;
    try {
      resolvedImageUrl = await processWorkerResolveImage(request, orgId);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }

    if (!resolvedImageUrl) {
      return reply.code(400).send({ error: 'A proof photo is required to resolve tickets' });
    }

    const alreadyConnected = ticket.resolvedWorkers.some(w => w.id === workerId);
    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'RESOLVED_PENDING_VERIFY',
        resolvedAt: new Date(),
        resolvedImageUrl,
        resolvedNote: note,
        resolvedWorkers: alreadyConnected ? undefined : { connect: [{ id: workerId }] }
      },
      include: {
        location: { select: { id: true, name: true, type: true } },
        resolvedWorkers: { select: { id: true, name: true } }
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'worker',
        actorId: workerId,
        action: 'ticket_resolved_by_worker',
        entityType: 'Ticket',
        entityId: ticket.id,
        oldValue: { status: ticket.status },
        newValue: { status: 'RESOLVED_PENDING_VERIFY', resolvedNote: note }
      }
    });

    notifyAdmins(orgId, {
      type: 'ticket_resolved',
      title: 'Ticket needs verification',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: updated.id
    }).catch(() => {});

    // Notify assigned supervisor urgently to verify
    if (ticket.assignedToId) {
      createNotification({
        orgId,
        userId: ticket.assignedToId,
        type: 'ticket_pending_verify',
        title: '⚡ Verify Required: ' + updated.title,
        body: 'Electrician marked work done. Please verify and close.',
        entityId: updated.id,
        isUrgent: true
      }).catch(() => {});
    }

    return updated;
  });
}

module.exports = workerAuthRoutes;
module.exports.authenticateWorkerJWT = authenticateWorkerJWT;
