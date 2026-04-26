'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { createNotification, notifyAdmins } = require('./notifications');
const { evaluateEvent } = require('../services/automation');
const { sendEmail, emailAdmins, escHtml } = require('../lib/email');
const { getAssignedSupervisorIds } = require('../services/assignment-resolver');

// SLA deadlines by priority (milliseconds)
const SLA_MS = { URGENT: 2 * 60 * 60 * 1000, HIGH: 4 * 60 * 60 * 1000, NORMAL: 24 * 60 * 60 * 1000, LOW: 72 * 60 * 60 * 1000 };

function getSlaDeadline(priority) {
  const ms = SLA_MS[priority] || SLA_MS.NORMAL;
  return new Date(Date.now() + ms);
}

const TICKET_INCLUDE = {
  location: { select: { id: true, name: true, type: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  assignedTo: { select: { id: true, name: true } },
  resolvedWorkers: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } }
};

// Strip reviewToken from ticket responses — only expose computed reviewUrl
function sanitizeTicket(t) {
  if (t && t.reviewToken) {
    if (t.reviewStatus === 'PENDING') t.reviewUrl = '/review/' + t.reviewToken;
    delete t.reviewToken;
  }
  return t;
}

// Lazy auto-close: batch-close PUBLIC tickets whose review window has expired
async function autoCloseExpiredReviews(orgId) {
  try {
    await prisma.ticket.updateMany({
      where: {
        orgId,
        source: 'PUBLIC',
        reviewStatus: 'PENDING',
        reviewExpiresAt: { lt: new Date() }
      },
      data: {
        reviewStatus: 'CONFIRMED',
        status: 'CLOSED',
        reviewedAt: new Date()
      }
    });
  } catch (err) { console.error('autoCloseExpiredReviews:', err.message); }
}

async function processImage(request, orgId) {
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

async function ticketRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Create ticket (ADMIN or SUPERVISOR, supports multipart for optional image) ──
  fastify.post('/tickets', async (request, reply) => {
    const orgId = request.user.orgId;
    let data, imageUrl = null;

    if (request.isMultipart()) {
      const fv = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };
      data = {
        locationId: fv(request.body.locationId),
        title: fv(request.body.title)?.trim(),
        description: fv(request.body.description)?.trim() || null,
        priority: fv(request.body.priority) || 'NORMAL',
        module: fv(request.body.module) || 'ele'
      };
      // Validate priority from multipart before proceeding
      const validPrioritiesMp = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
      if (!validPrioritiesMp.includes(data.priority)) {
        return reply.code(400).send({ error: 'Invalid priority' });
      }
      try { imageUrl = await processImage(request, orgId); } catch (e) {
        return reply.code(400).send({ error: e.message });
      }
    } else {
      const schema = z.object({
        locationId: z.string().uuid(),
        title: z.string().min(1).max(200).trim(),
        description: z.string().max(1000).optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
        module: z.string().max(20).default('ele')
      });
      data = schema.parse(request.body);
    }

    if (!data.locationId || !data.title) {
      return reply.code(400).send({ error: 'locationId and title are required' });
    }
    const validPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
    if (data.priority && !validPriorities.includes(data.priority)) {
      return reply.code(400).send({ error: 'Invalid priority' });
    }

    // Validate module is enabled for this org
    const ticketModule = data.module || 'ele';
    if (request.user.role !== 'SUPER_ADMIN') {
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { enabledModules: true } });
      const enabledMods = org?.enabledModules || ['ele'];
      if (!enabledMods.includes(ticketModule)) {
        return reply.code(403).send({ error: 'Module not enabled for your organization' });
      }
    }

    const location = await prisma.location.findFirst({ where: { id: data.locationId, orgId } });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    const ticket = await prisma.ticket.create({
      data: {
        orgId,
        locationId: data.locationId,
        createdById: request.user.id,
        title: data.title,
        description: data.description || null,
        imageUrl,
        priority: data.priority || 'NORMAL',
        module: data.module || 'ele',
        slaDeadlineAt: getSlaDeadline(data.priority || 'NORMAL')
      },
      include: TICKET_INCLUDE
    });

    // Auto-assign to first matching supervisor based on location hierarchy
    try {
      const supervisorIds = await getAssignedSupervisorIds(data.locationId, orgId);
      if (supervisorIds.length > 0) {
        const firstSup = supervisorIds[0];
        await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedToId: firstSup } });
        ticket.assignedToId = firstSup;
        createNotification({
          orgId,
          userId: firstSup,
          type: 'ticket_assigned',
          title: 'New ticket assigned to you',
          body: ticket.title + (location ? ' — ' + location.name : ''),
          entityId: ticket.id
        }).catch(() => {});
      }
    } catch (_) { /* non-fatal */ }

    // Fire-and-forget: alert evaluation for high-priority tickets
    const ticketPri = data.priority || 'NORMAL';
    if (ticketPri === 'HIGH' || ticketPri === 'URGENT') {
      evaluateEvent('TICKET_HIGH_PRIORITY', orgId, {
        entityType: 'ticket', entityId: ticket.id,
        priority: ticketPri, ticketTitle: data.title,
        locationId: data.locationId, locationName: location.name,
        module: data.module || 'ele'
      }, fastify.log).catch(() => {});
    }

    return sanitizeTicket(ticket);
  });

  // ── List tickets ──
  // Supervisors see tickets assigned to them + unassigned OPEN tickets; Admins see all
  fastify.get('/tickets', async (request) => {
    const orgId = request.user.orgId;

    // Lazy auto-close expired public reviews (non-blocking)
    autoCloseExpiredReviews(orgId);

    const { status, locationId, priority, source, module, page, limit, search, assignedToId, from, to, pool } = request.query;

    const where = { orgId };
    if (module) where.module = module;
    if (request.user.role === 'SUPERVISOR') {
      if (pool === 'unassigned') {
        // Show only unassigned open tickets (pickup pool)
        where.assignedToId = null;
        where.status = 'OPEN';
      } else {
        // Show assigned-to-me tickets + unassigned open + pending-verify tickets
        where.OR = [
          { assignedToId: request.user.id },
          { assignedToId: null, status: 'OPEN' },
          { status: 'RESOLVED_PENDING_VERIFY', assignedToId: request.user.id }
        ];
      }
    }
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
    }
    if (locationId) where.locationId = locationId;
    if (priority) where.priority = priority;
    if (source) where.source = source;
    if (assignedToId) where.assignedToId = assignedToId;
    if (search) {
      const searchOR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchOR }];
        delete where.OR;
      } else {
        where.OR = searchOR;
      }
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from + 'T00:00:00Z');
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59Z');
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
        include: TICKET_INCLUDE
      }),
      prisma.ticket.count({ where })
    ]);

    // Count stats per status (org-wide, ignoring filters)
    const statsWhere = { orgId };
    if (request.user.role === 'SUPERVISOR') {
      statsWhere.OR = [
        { assignedToId: request.user.id },
        { assignedToId: null, status: 'OPEN' },
        { status: 'RESOLVED_PENDING_VERIFY', assignedToId: request.user.id }
      ];
    }
    const statCounts = await prisma.ticket.groupBy({
      by: ['status'],
      where: statsWhere,
      _count: true
    });
    const stats = { OPEN: 0, IN_PROGRESS: 0, RESOLVED_PENDING_VERIFY: 0, RESOLVED: 0, CLOSED: 0 };
    for (const s of statCounts) stats[s.status] = (stats[s.status] || 0) + s._count;

    // For supervisors, also count unassigned open tickets separately
    let unassignedCount = 0;
    if (request.user.role === 'SUPERVISOR') {
      unassignedCount = await prisma.ticket.count({ where: { orgId, assignedToId: null, status: 'OPEN' } });
    }

    for (const t of tickets) sanitizeTicket(t);
    return { tickets, total, page: Math.floor(skip / take) + 1, pages: Math.ceil(total / take), stats, unassignedCount };
  });

  // ── Get single ticket ──
  fastify.get('/tickets/:id', async (request, reply) => {
    const { id } = request.params;
    const where = { id, orgId: request.user.orgId };
    if (request.user.role === 'SUPERVISOR') {
      // Supervisors can view their assigned tickets + unassigned open tickets + pending-verify tickets
      where.OR = [
        { assignedToId: request.user.id },
        { assignedToId: null, status: 'OPEN' },
        { status: 'RESOLVED_PENDING_VERIFY', assignedToId: request.user.id }
      ];
    }
    const ticket = await prisma.ticket.findFirst({ where, include: TICKET_INCLUDE });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    return sanitizeTicket(ticket);
  });

  // ── Update ticket (Admin only): assign, change status/priority ──
  fastify.patch('/tickets/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED_PENDING_VERIFY', 'RESOLVED', 'CLOSED']).optional(),
      assignedToId: z.string().uuid().optional().nullable(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional()
    });

    const data = schema.parse(request.body);

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId: request.user.orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });

    let assigneeEmail = null;
    if (data.assignedToId) {
      const assignee = await prisma.user.findFirst({
        where: { id: data.assignedToId, orgId: request.user.orgId, role: 'SUPERVISOR', isActive: true },
        select: { id: true, email: true }
      });
      if (!assignee) return reply.code(400).send({ error: 'Assignee not found or not a supervisor' });
      assigneeEmail = assignee.email;
    }

    const updateData = { ...data };
    if (data.status === 'RESOLVED' && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }
    if (data.status === 'CLOSED' && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: updateData,
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'ticket_updated',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status, assignedToId: ticket.assignedToId, priority: ticket.priority },
        newValue: data
      }
    });

    // Notify supervisor when ticket is assigned to them
    if (data.assignedToId && data.assignedToId !== ticket.assignedToId) {
      createNotification({
        orgId: request.user.orgId,
        userId: data.assignedToId,
        type: 'ticket_assigned',
        title: 'New ticket assigned to you',
        body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
        entityId: id
      }).catch(() => {});

      // Email the supervisor about the assignment
      if (assigneeEmail) {
        sendEmail(assigneeEmail, 'Ticket Assigned to You',
          `<p>A ticket has been assigned to you.</p>
           <p><span class="label">Ticket:</span> <span class="val">${escHtml(updated.title)}</span></p>
           ${updated.location ? `<p><span class="label">Location:</span> <span class="val">${escHtml(updated.location.name)}</span></p>` : ''}
           <p><span class="label">Priority:</span> <span class="val">${escHtml(updated.priority || 'NORMAL')}</span></p>
           <p style="margin-top:16px;color:#888;font-size:12px">Please log in to review and accept the ticket.</p>`
        ).catch(() => {});
      }
    }

    return sanitizeTicket(updated);
  });

  // ── Supervisor: Accept ticket (mark IN_PROGRESS) ──
  fastify.post('/tickets/:id/accept', {
    preHandler: [requireRole('SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const ticket = await prisma.ticket.findFirst({
      where: { id, orgId: request.user.orgId, assignedToId: request.user.id }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found or not assigned to you' });
    if (ticket.status !== 'OPEN') {
      return reply.code(400).send({ error: 'Only OPEN tickets can be accepted' });
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: { status: 'IN_PROGRESS' },
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'supervisor',
        actorId: request.user.id,
        action: 'ticket_accepted',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: 'OPEN' },
        newValue: { status: 'IN_PROGRESS' }
      }
    });

    return sanitizeTicket(updated);
  });

  // ── Supervisor: Pick up unassigned ticket (self-assign + mark IN_PROGRESS) ──
  fastify.post('/tickets/:id/pickup', {
    preHandler: [requireRole('SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const ticket = await prisma.ticket.findFirst({
      where: { id, orgId: request.user.orgId, assignedToId: null, status: 'OPEN' }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found or already assigned' });

    const updated = await prisma.ticket.update({
      where: { id },
      data: { assignedToId: request.user.id, status: 'IN_PROGRESS' },
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'supervisor',
        actorId: request.user.id,
        action: 'ticket_picked_up',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: 'OPEN', assignedToId: null },
        newValue: { status: 'IN_PROGRESS', assignedToId: request.user.id }
      }
    });

    // Notify admins that supervisor picked up a ticket
    notifyAdmins(request.user.orgId, {
      type: 'ticket_assigned',
      title: 'Ticket picked up',
      body: (request.user.name || 'Supervisor') + ' picked up: ' + updated.title,
      entityId: id
    }).catch(() => {});

    return sanitizeTicket(updated);
  });

  // ── Resolve ticket with proof photo (ADMIN or assigned SUPERVISOR) ──
  fastify.post('/tickets/:id/resolve', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });

    // Supervisors can only resolve tickets assigned to them
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only resolve tickets assigned to you' });
    }

    if (ticket.status === 'CLOSED') {
      return reply.code(400).send({ error: 'Ticket is already closed' });
    }

    let resolvedImageUrl = null;
    let resolvedNote = null;
    let workerIdsRaw = null;

    if (request.isMultipart()) {
      const fv = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };
      resolvedNote = fv(request.body.note)?.trim() || null;
      workerIdsRaw = fv(request.body.workerIds);
      try { resolvedImageUrl = await processImage(request, orgId); } catch (e) {
        return reply.code(400).send({ error: e.message });
      }
    } else if (request.body) {
      resolvedNote = request.body.note?.trim() || null;
      workerIdsRaw = request.body.workerIds;
    }

    // Parse worker IDs (optional)
    let workerIdList = [];
    if (workerIdsRaw) {
      try {
        workerIdList = typeof workerIdsRaw === 'string' ? JSON.parse(workerIdsRaw) : (Array.isArray(workerIdsRaw) ? workerIdsRaw : []);
      } catch { /* ignore parse error */ }
    }

    // Validate workers belong to same org if provided
    if (workerIdList.length > 0) {
      const workers = await prisma.worker.findMany({
        where: { id: { in: workerIdList }, orgId, isActive: true }
      });
      if (workers.length !== workerIdList.length) {
        return reply.code(400).send({ error: 'One or more workers not found or inactive' });
      }
    }

    // Require proof photo for resolution
    if (!resolvedImageUrl) {
      return reply.code(400).send({ error: 'A proof photo is required to resolve tickets' });
    }

    const updateData = {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedImageUrl,
      resolvedNote
    };
    if (workerIdList.length > 0) {
      updateData.resolvedWorkers = { connect: workerIdList.map(id => ({ id })) };
    }

    // Generate review token for PUBLIC tickets
    if (ticket.source === 'PUBLIC') {
      updateData.reviewToken = crypto.randomBytes(32).toString('hex');
      updateData.reviewExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
      updateData.reviewStatus = 'PENDING';
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: updateData,
      include: {
        ...TICKET_INCLUDE,
        resolvedWorkers: { select: { id: true, name: true } }
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'ticket_resolved',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status },
        newValue: { status: 'RESOLVED', resolvedNote }
      }
    });

    // Notify admins that ticket was resolved
    notifyAdmins(orgId, {
      type: 'ticket_resolved',
      title: 'Ticket resolved',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    // Email admins about the resolution
    emailAdmins(prisma, orgId, 'Ticket Resolved',
      `<p>A ticket has been resolved.</p>
       <p><span class="label">Ticket:</span> <span class="val">${escHtml(updated.title)}</span></p>
       ${updated.location ? `<p><span class="label">Location:</span> <span class="val">${escHtml(updated.location.name)}</span></p>` : ''}
       ${resolvedNote ? `<p><span class="label">Note:</span> <span class="val">${escHtml(resolvedNote)}</span></p>` : ''}
       <p style="margin-top:16px;color:#888;font-size:12px">Log in to the dashboard to review the resolution.</p>`
    ).catch(() => {});

    const response = { ...updated };
    if (updated.reviewToken) {
      response.reviewUrl = `/review/${updated.reviewToken}`;
    }
    delete response.reviewToken;
    return response;
  });

  // ── Supervisor: Verify a ticket (after worker marks RESOLVED_PENDING_VERIFY) ──
  fastify.post('/tickets/:id/verify', {
    preHandler: [requireRole('SUPERVISOR', 'ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      note: z.string().max(500).optional()
    });
    const data = schema.parse(request.body || {});

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status !== 'RESOLVED_PENDING_VERIFY') {
      return reply.code(400).send({ error: 'Only RESOLVED_PENDING_VERIFY tickets can be verified' });
    }
    // Supervisors can only verify tickets assigned to them
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only verify tickets assigned to you' });
    }

    const updateData = {
      status: 'RESOLVED',
      verifiedAt: new Date(),
      verifiedById: request.user.id,
      verifyNote: data.note?.trim() || null
    };

    // Generate review token for PUBLIC tickets
    if (ticket.source === 'PUBLIC' && !ticket.reviewToken) {
      updateData.reviewToken = crypto.randomBytes(32).toString('hex');
      updateData.reviewExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      updateData.reviewStatus = 'PENDING';
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: updateData,
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'ticket_verified',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: 'RESOLVED_PENDING_VERIFY' },
        newValue: { status: 'RESOLVED', verifyNote: data.note || null }
      }
    });

    notifyAdmins(orgId, {
      type: 'ticket_resolved',
      title: 'Ticket verified & resolved',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    // Notify workers who resolved it
    if (ticket.resolvedWorkers) {
      // resolvedWorkers loaded via TICKET_INCLUDE
    }

    const response = { ...updated };
    if (updated.reviewToken) {
      response.reviewUrl = `/review/${updated.reviewToken}`;
    }
    delete response.reviewToken;
    return sanitizeTicket(response);
  });

  // ── Supervisor/Admin: Reopen ticket (reject worker resolution) ──
  fastify.post('/tickets/:id/reopen', {
    preHandler: [requireRole('SUPERVISOR', 'ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      note: z.string().max(500).optional()
    });
    const data = schema.parse(request.body || {});

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status !== 'RESOLVED_PENDING_VERIFY') {
      return reply.code(400).send({ error: 'Only RESOLVED_PENDING_VERIFY tickets can be reopened this way' });
    }
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only reopen tickets assigned to you' });
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status: 'IN_PROGRESS',
        resolvedAt: null,
        resolvedImageUrl: null,
        resolvedNote: data.note?.trim() || null,
        resolvedWorkers: { set: [] }
      },
      include: TICKET_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'ticket_reopened',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: 'RESOLVED_PENDING_VERIFY' },
        newValue: { status: 'IN_PROGRESS', reopenNote: data.note || null }
      }
    });

    // Notify workers assigned to this location that ticket was rejected
    notifyAdmins(orgId, {
      type: 'ticket_reopened',
      title: 'Ticket resolution rejected',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    return sanitizeTicket(updated);
  });
}

module.exports = ticketRoutes;
