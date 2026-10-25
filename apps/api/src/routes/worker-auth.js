'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST, hashResetToken, JWT_VERIFY_OPTIONS } = require('../lib/security');
const { loginRateLimit, strictRateLimit } = require('../middleware/rateLimits');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { getLocationDescendants } = require('../services/assignment-resolver');
const { normalizeEnabledModules } = require('../services/module-policy');
const { notifyAdmins, createNotification } = require('./notifications');
const { attachTenantContextFromWorker } = require('../middleware/tenant-context');
const { sendEmail, escHtml } = require('../lib/email');
const { APP_URL } = require('../config/env');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Matches the anti-enumeration delay already used on worker-login's
// invalid-credential paths below.
async function antiEnumerationDelay() {
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
}
const {
  TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  ACTIVE_TICKET_STATUSES,
  VERIFY_PENDING_TICKET_STATUSES,
  EDITABLE_TICKET_STATUSES,
  isOpenLikeStatus,
  isActiveLikeStatus,
  STALE_TICKET_ERROR,
  updateTicketIfUnchanged
} = require('../services/ticket-status');

const VALID_MODULES = ['ele', 'civil', 'asset', 'complaints'];

// The ticket fields an electrician's app may see — an allow-list, not `include`. A bare
// `include` returns every column, among them the guest's review token (which confirms the
// work "as the resident"), and their name, phone, IP hash and user agent. [BUG-0027]
const WORKER_TICKET_SELECT = Object.freeze({
  id: true,
  locationId: true,
  title: true,
  description: true,
  imageUrl: true,
  priority: true,
  status: true,
  source: true,
  module: true,
  issueType: true,
  resolvedImageUrl: true,
  resolvedNote: true,
  resolvedAt: true,
  acceptedAt: true,
  verifiedAt: true,
  verifyNote: true,
  createdAt: true,
  updatedAt: true,
  location: { select: { id: true, name: true, type: true } },
  assignedTo: { select: { id: true, name: true } },
  resolvedWorkers: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } }
});

// ── Worker JWT Authentication Middleware ──

async function authenticateWorkerJWT(request, reply) {
  try {
    const token = request.headers.authorization?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
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
    attachTenantContextFromWorker(request, worker);
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

async function workerAuthRoutes(fastify) {

  function getModuleFilter(queryModule) {
    if (!queryModule) return null;
    const mod = String(queryModule).trim().toLowerCase();
    return VALID_MODULES.includes(mod) ? mod : null;
  }

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
      select: { id: true, name: true, status: true, enabledModules: true }
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
      org: {
        id: org.id,
        name: org.name,
        enabledModules: normalizeEnabledModules(org.enabledModules)
      }
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
      select: { id: true, name: true, slug: true, enabledModules: true }
    });
    if (org) {
      org.enabledModules = normalizeEnabledModules(org.enabledModules);
    }
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

    // Reissue a fresh token so the current session stays alive — previously
    // this endpoint set tokenInvalidBefore (correctly invalidating the old
    // token) without ever giving the worker a new one, forcing an immediate
    // re-login right after a successful PIN change. Matches the existing
    // pattern in PATCH /auth/password for admin/supervisor users. [WP14]
    const newToken = jwt.sign(
      { workerId: request.worker.id, orgId: request.worker.orgId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return { success: true, token: newToken };
  });

  // Request a self-service PIN reset via email. Always returns the same
  // generic response regardless of whether the org/employeeId matches a
  // worker, or whether that worker has an email on file. [WP14]
  fastify.post('/auth/worker-forgot-pin', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      orgSlug: z.string().min(1).max(100).trim(),
      employeeId: z.string().min(1).max(50).trim()
    });

    let data;
    try { data = schema.parse(request.body); } catch (err) {
      return reply.code(400).send({ error: 'Invalid input', details: err.errors });
    }

    const genericResponse = { success: true, message: 'If a matching worker account with an email on file exists, a PIN reset link has been sent.' };

    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
      select: { id: true, status: true }
    });

    if (org && org.status === 'ACTIVE') {
      const worker = await prisma.worker.findFirst({
        where: { orgId: org.id, employeeId: data.employeeId, isActive: true },
        select: { id: true, name: true, email: true }
      });

      if (worker && worker.email) {
        const token = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        // Only the hash is stored; the e-mailed token is the credential. [BUG-0034]
        await prisma.worker.update({
          where: { id: worker.id },
          data: { resetToken: hashResetToken(token), resetTokenExpiresAt }
        });

        const resetUrl = `${APP_URL}/worker-reset-pin?token=${token}`;
        sendEmail(
          worker.email,
          'Reset your PIN',
          `<p>Hi ${escHtml(worker.name)},</p>
           <p>We received a request to reset your login PIN. This link is valid for 1 hour and can only be used once.</p>
           <p><a class="btn" href="${resetUrl}">Reset PIN</a></p>
           <p>If you didn't request this, you can safely ignore this email — your PIN won't be changed.</p>`
        ).catch(() => {});
      }
    }

    await antiEnumerationDelay();
    return genericResponse;
  });

  // Complete a self-service PIN reset. [WP14]
  fastify.post('/auth/worker-reset-pin', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      token: z.string().min(1),
      newPin: z.string().min(6).max(6).regex(/^\d+$/, 'PIN must be exactly 6 digits')
    });

    let data;
    try { data = schema.parse(request.body); } catch (err) {
      return reply.code(400).send({ error: 'Invalid input', details: err.errors });
    }

    const worker = await prisma.worker.findUnique({
      where: { resetToken: hashResetToken(data.token) },
      select: { id: true, orgId: true, name: true, employeeId: true, isActive: true, resetTokenExpiresAt: true }
    });

    if (!worker || !worker.isActive || !worker.resetTokenExpiresAt || worker.resetTokenExpiresAt < new Date()) {
      await antiEnumerationDelay();
      return reply.code(400).send({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const newPinHash = await bcrypt.hash(data.newPin, BCRYPT_COST);
    // Single-use + session invalidation, matching /auth/reset-password.
    await prisma.worker.update({
      where: { id: worker.id },
      data: {
        pinHash: newPinHash,
        tokenInvalidBefore: new Date(),
        resetToken: null,
        resetTokenExpiresAt: null
      }
    });

    const newToken = jwt.sign(
      { workerId: worker.id, orgId: worker.orgId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return {
      success: true,
      message: 'PIN reset successfully',
      token: newToken,
      worker: { id: worker.id, name: worker.name, employeeId: worker.employeeId }
    };
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

  fastify.delete('/worker/notifications/clear-read', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const result = await prisma.notification.deleteMany({
      where: { workerId: request.worker.id, isRead: true }
    });
    return { success: true, deleted: result.count };
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
    const moduleFilter = getModuleFilter(request.query.module);
    const limit = Math.min(parseInt(request.query.limit, 10) || 50, 100);
    const page = Math.max(parseInt(request.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) {
      const emptyStats = EDITABLE_TICKET_STATUSES.reduce((acc, status) => {
        acc[status] = 0;
        return acc;
      }, {});
      return { tickets: [], total: 0, page, pages: 0, stats: emptyStats };
    }

    const statuses = request.query.status
      ? String(request.query.status).split(',').map(s => s.trim()).filter(Boolean)
      : [...ACTIVE_TICKET_STATUSES, ...VERIFY_PENDING_TICKET_STATUSES];

    const where = {
      orgId,
      locationId: { in: locationIds },
      status: statuses.length > 1 ? { in: statuses } : statuses[0]
    };
    if (moduleFilter) where.module = moduleFilter;

    const groupedWhere = { orgId, locationId: { in: locationIds } };
    if (moduleFilter) groupedWhere.module = moduleFilter;

    const [tickets, total, grouped] = await Promise.all([
      prisma.ticket.findMany({
        where,
        select: WORKER_TICKET_SELECT,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.groupBy({
        by: ['status'],
        where: groupedWhere,
        _count: true
      })
    ]);

    const stats = EDITABLE_TICKET_STATUSES.reduce((acc, status) => {
      acc[status] = 0;
      return acc;
    }, {});
    for (const g of grouped) stats[g.status] = (stats[g.status] || 0) + g._count;

    return { tickets, total, page, pages: Math.ceil(total / limit), stats };
  });

  fastify.get('/worker/tickets/:id', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const moduleFilter = getModuleFilter(request.query.module);
    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) return reply.code(404).send({ error: 'Ticket not found' });

    const where = { id: request.params.id, orgId, locationId: { in: locationIds } };
    if (moduleFilter) where.module = moduleFilter;

    const ticket = await prisma.ticket.findFirst({
      where,
      select: WORKER_TICKET_SELECT
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
    if (ticket.status === TICKET_STATUSES.CLOSED || ticket.status === TICKET_STATUSES.CANCELLED) {
      return reply.code(400).send({ error: 'Ticket is already closed' });
    }
    // Only work still to be done can be resolved — the same statuses the app offers
    // "Resolve With Photo" for. A ticket waiting for verification, or already verified,
    // must not be sent back to RESOLVED_PENDING_VERIFY by an electrician. [BUG-0015]
    if (!isActiveLikeStatus(ticket.status)) {
      return reply.code(400).send({ error: 'This ticket is already resolved' });
    }

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
    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      data: {
        status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY,
        resolvedAt: new Date(),
        resolvedImageUrl,
        resolvedNote: note,
        resolvedWorkers: alreadyConnected ? undefined : { connect: [{ id: workerId }] }
      },
      select: WORKER_TICKET_SELECT
    });
    if (!updated) {
      deleteFromR2(resolvedImageUrl).catch(() => {}); // the photo for a write that did not land
      return reply.code(409).send({ error: STALE_TICKET_ERROR });
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'worker',
        actorId: workerId,
        action: 'ticket_resolved_by_worker',
        entityType: 'Ticket',
        entityId: ticket.id,
        oldValue: { status: ticket.status },
        newValue: { status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY, resolvedNote: note }
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

  // ── Electrician: QR code → Location lookup (for scan) ──
  fastify.get('/worker/locations/qr/:code', {
    preHandler: [authenticateWorkerJWT]
  }, async (request, reply) => {
    const code = request.params.code.toUpperCase().trim();
    const orgId = request.worker.orgId;
    const moduleFilter = getModuleFilter(request.query.module);
    const location = await prisma.location.findUnique({
      where: { qrCode: code },
      include: { parent: { select: { id: true, name: true, type: true } } }
    });
    if (!location || location.orgId !== orgId) {
      return reply.code(404).send({ error: 'Location not found' });
    }
    if (!location.isActive) {
      return reply.code(410).send({ error: 'Location is deactivated' });
    }
    // Verify worker covers this location
    const workerLocationIds = await getWorkerCoverageLocationIds(request.worker.id, orgId);
    const isCovered = workerLocationIds.includes(location.id);

    // Open ticket count at this location
    const openTicketWhere = { orgId, locationId: location.id, status: { in: ACTIVE_TICKET_STATUSES } };
    if (moduleFilter) openTicketWhere.module = moduleFilter;
    const openTickets = await prisma.ticket.count({
      where: openTicketWhere
    });

    return { ...location, isCovered, openTickets };
  });

  // ── Electrician: Unassigned ticket pool (in worker's coverage) ──
  fastify.get('/worker/tickets/pool', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const moduleFilter = getModuleFilter(request.query.module);
    const locationIds = await getWorkerCoverageLocationIds(workerId, orgId);
    if (!locationIds.length) return { tickets: [], total: 0 };

    const where = {
      orgId,
      locationId: { in: locationIds },
      status: { in: OPEN_TICKET_STATUSES },
      NOT: { resolvedWorkers: { some: { id: workerId } } }
    };
    if (moduleFilter) where.module = moduleFilter;

    const tickets = await prisma.ticket.findMany({
      where,
      select: WORKER_TICKET_SELECT,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 100
    });
    return { tickets, total: tickets.length };
  });

  // ── Electrician: Pickup ticket (claim and start work) ──
  fastify.post('/worker/tickets/:id/pickup', {
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
    if (!isOpenLikeStatus(ticket.status) && !isActiveLikeStatus(ticket.status)) {
      return reply.code(400).send({ error: 'Ticket cannot be picked up in its current state' });
    }

    const alreadyConnected = ticket.resolvedWorkers.some(w => w.id === workerId);
    // Several electricians may join one ticket, so concurrent pickups both land; only a
    // change to a status that can no longer be picked up (resolved, closed) refuses. [BUG-0038]
    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      where: { status: { in: ACTIVE_TICKET_STATUSES } },
      data: {
        status: TICKET_STATUSES.IN_PROGRESS,
        acceptedAt: ticket.acceptedAt || new Date(),
        resolvedWorkers: alreadyConnected ? undefined : { connect: [{ id: workerId }] }
      },
      select: WORKER_TICKET_SELECT
    });
    if (!updated) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'worker',
        actorId: workerId,
        action: 'ticket_picked_up',
        entityType: 'Ticket',
        entityId: ticket.id,
        oldValue: { status: ticket.status },
        newValue: { status: TICKET_STATUSES.IN_PROGRESS }
      }
    });

    if (ticket.assignedToId) {
      createNotification({
        orgId,
        userId: ticket.assignedToId,
        type: 'ticket_picked_up',
        title: 'Electrician started work',
        body: updated.title + ' — picked up by ' + request.worker.name,
        entityId: updated.id
      }).catch(() => {});
    }

    return updated;
  });

  // ── Electrician: My Work history (last N days of work I did) ──
  fastify.get('/worker/my-work', {
    preHandler: [authenticateWorkerJWT]
  }, async (request) => {
    const orgId = request.worker.orgId;
    const workerId = request.worker.id;
    const moduleFilter = getModuleFilter(request.query.module);
    const days = Math.min(Math.max(parseInt(request.query.days, 10) || 30, 1), 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where = {
      orgId,
      resolvedWorkers: { some: { id: workerId } },
      OR: [
        { resolvedAt: { gte: cutoff } },
        { acceptedAt: { gte: cutoff } },
        { updatedAt: { gte: cutoff } }
      ]
    };
    if (moduleFilter) where.module = moduleFilter;

    const tickets = await prisma.ticket.findMany({
      where,
      select: WORKER_TICKET_SELECT,
      orderBy: [{ resolvedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 200
    });

    const counts = { total: tickets.length, verified: 0, pendingVerify: 0, inProgress: 0, reopened: 0 };
    for (const t of tickets) {
      if (t.status === TICKET_STATUSES.RESOLVED || t.status === TICKET_STATUSES.CLOSED) counts.verified++;
      else if (t.status === TICKET_STATUSES.RESOLVED_PENDING_VERIFY) counts.pendingVerify++;
      else if (t.status === TICKET_STATUSES.IN_PROGRESS || t.status === TICKET_STATUSES.ON_HOLD) counts.inProgress++;
      else if (isOpenLikeStatus(t.status)) counts.reopened++;
    }

    return { tickets, days, counts };
  });
}

module.exports = workerAuthRoutes;
module.exports.authenticateWorkerJWT = authenticateWorkerJWT;
