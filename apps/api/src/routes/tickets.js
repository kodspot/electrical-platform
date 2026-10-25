'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requirePolicy } = require('../middleware/auth');
const { createNotification, notifyAdmins } = require('./notifications');
const { notify } = require('../services/notification-service');
const { evaluateEvent } = require('../services/automation');
const { escHtml } = require('../lib/email');
const { getAssignedSupervisorIds } = require('../services/assignment-resolver');
const { isModuleEnabled } = require('../services/module-policy');
const {
  TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  ACTIVE_TICKET_STATUSES,
  VERIFY_PENDING_TICKET_STATUSES,
  EDITABLE_TICKET_STATUSES,
  isOpenLikeStatus,
  STALE_TICKET_ERROR,
  updateTicketIfUnchanged
} = require('../services/ticket-status');
const { getSlaDeadline } = require('../services/ticket-status');

// Audit actorType for an org-scoped action — must distinguish a SuperAdmin
// acting via X-Org-Id org-entry from a genuine org ADMIN/SUPERVISOR, or a
// SuperAdmin's write gets silently mislabeled as 'supervisor'. [WP8]
function auditActorType(role) {
  if (role === 'ADMIN') return 'admin';
  if (role === 'SUPER_ADMIN') return 'super_admin';
  return 'supervisor';
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
        // Only a resolution awaiting the guest's review is auto-accepted. [BUG-0016]
        status: TICKET_STATUSES.RESOLVED,
        reviewStatus: 'PENDING',
        reviewExpiresAt: { lt: new Date() }
      },
      data: {
        reviewStatus: 'CONFIRMED',
        status: TICKET_STATUSES.CLOSED,
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
  fastify.addHook('preHandler', requirePolicy('ORG_STAFF'));

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
      if (!isModuleEnabled(org, ticketModule)) {
        return reply.code(403).send({ error: 'Module not enabled for your organization' });
      }
    }

    const location = await prisma.location.findFirst({ where: { id: data.locationId, orgId } });
    if (!location) return reply.code(404).send({ error: 'Location not found' });

    // Resolve auto-assignment before creating the ticket so it's set in the
    // same write, instead of a separate update afterward — a ticket that
    // should have been auto-assigned but wasn't (because a second write
    // failed) is a real workflow-integrity gap, not just a cosmetic one. [WP9]
    let firstSup = null;
    let supervisorLookupError = null;
    try {
      const supervisorIds = await getAssignedSupervisorIds(data.locationId, orgId);
      if (supervisorIds.length > 0) firstSup = supervisorIds[0];
    } catch (err) { supervisorLookupError = err; }

    // Fire-and-forget, but never silent: one warn line per failed step, no URL/token/email. [WP-H F4]
    const warnStep = (ticketId, step) => (err) => request.log.warn(
      { ticketId, step, err: String((err && err.message) || err).slice(0, 200) },
      'notification step failed'
    );

    const ticket = await prisma.ticket.create({
      data: {
        orgId,
        locationId: data.locationId,
        createdById: request.user.id,
        assignedToId: firstSup,
        title: data.title,
        description: data.description || null,
        imageUrl,
        priority: data.priority || 'NORMAL',
        module: data.module || 'ele',
        slaDeadlineAt: getSlaDeadline(data.priority || 'NORMAL')
      },
      include: TICKET_INCLUDE
    });
    if (supervisorLookupError) warnStep(ticket.id, 'resolve_supervisors')(supervisorLookupError);

    if (firstSup) {
      createNotification({
        orgId,
        userId: firstSup,
        type: 'ticket_assigned',
        title: 'New ticket assigned to you',
        body: ticket.title + (location ? ' — ' + location.name : ''),
        entityId: ticket.id
      }).catch(warnStep(ticket.id, 'notify_assigned_supervisor'));
    }

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
  // Supervisors see tickets assigned to them + unassigned open-like tickets; Admins see all
  fastify.get('/tickets', async (request) => {
    const orgId = request.user.orgId;

    // Lazy auto-close expired public reviews (non-blocking)
    autoCloseExpiredReviews(orgId);

    const { status, locationId, priority, source, module, page, limit, search, assignedToId, from, to, pool } = request.query;

    const where = { orgId };
    if (module) where.module = module;
    if (request.user.role === 'SUPERVISOR') {
      if (pool === 'unassigned') {
        // Show only unassigned open-like tickets (pickup pool)
        where.assignedToId = null;
        where.status = { in: OPEN_TICKET_STATUSES };
      } else {
        // Show assigned-to-me tickets + unassigned open-like + pending-verify tickets
        where.OR = [
          { assignedToId: request.user.id },
          { assignedToId: null, status: { in: OPEN_TICKET_STATUSES } },
          { status: { in: VERIFY_PENDING_TICKET_STATUSES }, assignedToId: request.user.id }
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
        { assignedToId: null, status: { in: OPEN_TICKET_STATUSES } },
        { status: { in: VERIFY_PENDING_TICKET_STATUSES }, assignedToId: request.user.id }
      ];
    }
    const statCounts = await prisma.ticket.groupBy({
      by: ['status'],
      where: statsWhere,
      _count: true
    });
    const stats = EDITABLE_TICKET_STATUSES.reduce((acc, status) => {
      acc[status] = 0;
      return acc;
    }, {});
    for (const s of statCounts) stats[s.status] = (stats[s.status] || 0) + s._count;

    // For supervisors, also count unassigned open tickets separately
    let unassignedCount = 0;
    if (request.user.role === 'SUPERVISOR') {
      unassignedCount = await prisma.ticket.count({ where: { orgId, assignedToId: null, status: { in: OPEN_TICKET_STATUSES } } });
    }

    for (const t of tickets) sanitizeTicket(t);
    return { tickets, total, page: Math.floor(skip / take) + 1, pages: Math.ceil(total / take), stats, unassignedCount };
  });

  // ── Get single ticket ──
  fastify.get('/tickets/:id', async (request, reply) => {
    const { id } = request.params;
    const where = { id, orgId: request.user.orgId };
    if (request.user.role === 'SUPERVISOR') {
      // Supervisors can view their assigned tickets + unassigned open-like tickets + pending-verify tickets
      where.OR = [
        { assignedToId: request.user.id },
        { assignedToId: null, status: { in: OPEN_TICKET_STATUSES } },
        { status: { in: VERIFY_PENDING_TICKET_STATUSES }, assignedToId: request.user.id }
      ];
    }
    const ticket = await prisma.ticket.findFirst({ where, include: TICKET_INCLUDE });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    return sanitizeTicket(ticket);
  });

  // ── Update ticket (Admin only): assign, change status/priority ──
  fastify.patch('/tickets/:id', {
    preHandler: [requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      status: z.enum(EDITABLE_TICKET_STATUSES).optional(),
      assignedToId: z.string().uuid().optional().nullable(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional()
    });

    const data = schema.parse(request.body);

    // RESOLVED_PENDING_VERIFY is reached only via a worker actually resolving
    // the ticket (POST /tickets/:id/resolve, worker-auth.js's equivalent),
    // which always carries resolution evidence a generic admin PATCH has no
    // way to supply — admins may not set it directly. [WP10]
    if (data.status === TICKET_STATUSES.RESOLVED_PENDING_VERIFY) {
      return reply.code(400).send({ error: 'RESOLVED_PENDING_VERIFY can only be reached by a worker resolving the ticket, not set directly' });
    }

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
    if (data.status === TICKET_STATUSES.RESOLVED && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }
    if (data.status === TICKET_STATUSES.CLOSED && !ticket.resolvedAt) {
      updateData.resolvedAt = new Date();
    }

    // Moving a previously-resolved/verified ticket back to an active status
    // must clear its resolution/verification fields the same way the
    // dedicated /reopen endpoint does — otherwise the record ends up
    // self-contradictory (e.g. status=OPEN but resolvedImageUrl/verifiedAt
    // still populated from a resolution that's no longer in effect). [WP10]
    if (data.status && ACTIVE_TICKET_STATUSES.includes(data.status) && (ticket.resolvedAt || ticket.verifiedAt)) {
      updateData.resolvedAt = null;
      updateData.resolvedImageUrl = null;
      updateData.resolvedNote = null;
      updateData.verifiedAt = null;
      updateData.verifiedById = null;
      updateData.verifyNote = null;
      updateData.resolvedWorkers = { set: [] };
    }
    // ...and withdraw a guest review that is still pending: its link would otherwise
    // still CONFIRM (close) the reopened ticket, and the lazy auto-close would close it
    // when the review window ran out. [BUG-0016]
    if (data.status && ACTIVE_TICKET_STATUSES.includes(data.status) && ticket.reviewStatus === 'PENDING') {
      updateData.reviewToken = null;
      updateData.reviewExpiresAt = null;
      updateData.reviewStatus = null;
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

    // Notify supervisor when ticket is assigned to them (in-app + paired email)
    if (data.assignedToId && data.assignedToId !== ticket.assignedToId) {
      notify({
        orgId: request.user.orgId,
        to: { userId: data.assignedToId },
        type: 'ticket_assigned',
        title: 'New ticket assigned to you',
        body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
        entityId: id,
        email: assigneeEmail ? {
          to: assigneeEmail,
          subject: 'Ticket Assigned to You',
          html: `<p>A ticket has been assigned to you.</p>
           <p><span class="label">Ticket:</span> <span class="val">${escHtml(updated.title)}</span></p>
           ${updated.location ? `<p><span class="label">Location:</span> <span class="val">${escHtml(updated.location.name)}</span></p>` : ''}
           <p><span class="label">Priority:</span> <span class="val">${escHtml(updated.priority || 'NORMAL')}</span></p>
           <p style="margin-top:16px;color:#888;font-size:12px">Please log in to review and accept the ticket.</p>`
        } : undefined
      }).catch(() => {});
    }

    return sanitizeTicket(updated);
  });

  // ── Supervisor: Accept ticket (mark IN_PROGRESS) ──
  fastify.post('/tickets/:id/accept', {
    preHandler: [requirePolicy('SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const ticket = await prisma.ticket.findFirst({
      where: { id, orgId: request.user.orgId, assignedToId: request.user.id }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found or not assigned to you' });
    if (!isOpenLikeStatus(ticket.status)) {
      return reply.code(400).send({ error: 'Only OPEN/ACKNOWLEDGED/ASSIGNED tickets can be accepted' });
    }

    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      where: { assignedToId: request.user.id },
      data: { status: TICKET_STATUSES.IN_PROGRESS },
      include: TICKET_INCLUDE
    });
    if (!updated) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'supervisor',
        actorId: request.user.id,
        action: 'ticket_accepted',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status },
        newValue: { status: TICKET_STATUSES.IN_PROGRESS }
      }
    });

    return sanitizeTicket(updated);
  });

  // ── Supervisor: Pick up unassigned ticket (self-assign + mark IN_PROGRESS) ──
  fastify.post('/tickets/:id/pickup', {
    preHandler: [requirePolicy('SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const ticket = await prisma.ticket.findFirst({
      where: { id, orgId: request.user.orgId, assignedToId: null, status: { in: OPEN_TICKET_STATUSES } }
    });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found or already assigned' });

    // Still unassigned, in the status checked: two supervisors picking it up at once can't
    // both get it. [BUG-0038]
    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      where: { assignedToId: null },
      data: { assignedToId: request.user.id, status: TICKET_STATUSES.IN_PROGRESS },
      include: TICKET_INCLUDE
    });
    if (!updated) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'supervisor',
        actorId: request.user.id,
        action: 'ticket_picked_up',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status, assignedToId: null },
        newValue: { status: TICKET_STATUSES.IN_PROGRESS, assignedToId: request.user.id }
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

    if (ticket.status === TICKET_STATUSES.CLOSED || ticket.status === TICKET_STATUSES.CANCELLED) {
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
      status: TICKET_STATUSES.RESOLVED,
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

    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      data: updateData,
      include: {
        ...TICKET_INCLUDE,
        resolvedWorkers: { select: { id: true, name: true } }
      }
    });
    if (!updated) {
      deleteFromR2(resolvedImageUrl).catch(() => {}); // the photo for a write that did not land
      return reply.code(409).send({ error: STALE_TICKET_ERROR });
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: auditActorType(request.user.role),
        actorId: request.user.id,
        action: 'ticket_resolved',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: ticket.status },
        newValue: { status: TICKET_STATUSES.RESOLVED, resolvedNote }
      }
    });

    // Notify admins that ticket was resolved (in-app + paired email)
    notify({
      orgId,
      to: { admins: true },
      type: 'ticket_resolved',
      title: 'Ticket resolved',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id,
      email: {
        toAdmins: true,
        subject: 'Ticket Resolved',
        html: `<p>A ticket has been resolved.</p>
       <p><span class="label">Ticket:</span> <span class="val">${escHtml(updated.title)}</span></p>
       ${updated.location ? `<p><span class="label">Location:</span> <span class="val">${escHtml(updated.location.name)}</span></p>` : ''}
       ${resolvedNote ? `<p><span class="label">Note:</span> <span class="val">${escHtml(resolvedNote)}</span></p>` : ''}
       <p style="margin-top:16px;color:#888;font-size:12px">Log in to the dashboard to review the resolution.</p>`
      }
    }).catch(() => {});

    const response = { ...updated };
    if (updated.reviewToken) {
      response.reviewUrl = `/review/${updated.reviewToken}`;
    }
    delete response.reviewToken;
    return response;
  });

  // ── Supervisor: Verify a ticket (after worker marks RESOLVED_PENDING_VERIFY) ──
  fastify.post('/tickets/:id/verify', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      note: z.string().max(500).optional()
    });
    const data = schema.parse(request.body || {});

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId }, include: { resolvedWorkers: { select: { id: true } } } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status !== TICKET_STATUSES.RESOLVED_PENDING_VERIFY) {
      return reply.code(400).send({ error: 'Only RESOLVED_PENDING_VERIFY tickets can be verified' });
    }
    // Supervisors can only verify tickets assigned to them
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only verify tickets assigned to you' });
    }

    const updateData = {
      status: TICKET_STATUSES.RESOLVED,
      verifiedAt: new Date(),
      verifiedById: request.user.id,
      verifyNote: data.note?.trim() || null
    };

    // Generate a review token for PUBLIC tickets — a fresh one unless a review is already
    // pending: after a guest rejected the last fix, the old token is spent. [BUG-0017]
    if (ticket.source === 'PUBLIC' && ticket.reviewStatus !== 'PENDING') {
      updateData.reviewToken = crypto.randomBytes(32).toString('hex');
      updateData.reviewExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      updateData.reviewStatus = 'PENDING';
    }

    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      data: updateData,
      include: TICKET_INCLUDE
    });
    if (!updated) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: auditActorType(request.user.role),
        actorId: request.user.id,
        action: 'ticket_verified',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY },
        newValue: { status: TICKET_STATUSES.RESOLVED, verifyNote: data.note || null }
      }
    });

    notifyAdmins(orgId, {
      type: 'ticket_resolved',
      title: 'Ticket verified & resolved',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    // Tell the electricians who resolved it that their work was accepted. [BUG-0018]
    notify({
      orgId,
      to: { workerIds: ticket.resolvedWorkers.map((w) => w.id) },
      type: 'ticket_verified',
      title: 'Your work was verified',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    const response = { ...updated };
    if (updated.reviewToken) {
      response.reviewUrl = `/review/${updated.reviewToken}`;
    }
    delete response.reviewToken;
    return sanitizeTicket(response);
  });

  // ── Supervisor/Admin: Reopen ticket (reject worker resolution) ──
  fastify.post('/tickets/:id/reopen', {
    preHandler: [requirePolicy('ORG_STAFF')]
  }, async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      note: z.string().max(500).optional()
    });
    const data = schema.parse(request.body || {});

    const ticket = await prisma.ticket.findFirst({ where: { id, orgId }, include: { resolvedWorkers: { select: { id: true } } } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status !== TICKET_STATUSES.RESOLVED_PENDING_VERIFY) {
      return reply.code(400).send({ error: 'Only RESOLVED_PENDING_VERIFY tickets can be reopened this way' });
    }
    if (request.user.role === 'SUPERVISOR' && ticket.assignedToId !== request.user.id) {
      return reply.code(403).send({ error: 'You can only reopen tickets assigned to you' });
    }

    const updated = await updateTicketIfUnchanged(prisma, ticket, {
      data: {
        status: TICKET_STATUSES.IN_PROGRESS,
        resolvedAt: null,
        resolvedImageUrl: null,
        resolvedNote: data.note?.trim() || null,
        resolvedWorkers: { set: [] }
      },
      include: TICKET_INCLUDE
    });
    if (!updated) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: auditActorType(request.user.role),
        actorId: request.user.id,
        action: 'ticket_reopened',
        entityType: 'Ticket',
        entityId: id,
        oldValue: { status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY },
        newValue: { status: TICKET_STATUSES.IN_PROGRESS, reopenNote: data.note || null }
      }
    });

    notifyAdmins(orgId, {
      type: 'ticket_reopened',
      title: 'Ticket resolution rejected',
      body: updated.title + (updated.location ? ' — ' + updated.location.name : ''),
      entityId: id
    }).catch(() => {});

    // Tell the electricians whose resolution was rejected, with the reason. [BUG-0018]
    notify({
      orgId,
      to: { workerIds: ticket.resolvedWorkers.map((w) => w.id) },
      type: 'ticket_reopened',
      title: 'Your fix was sent back',
      body: updated.title + (data.note?.trim() ? ' — ' + data.note.trim() : ''),
      entityId: id
    }).catch(() => {});

    return sanitizeTicket(updated);
  });
}

module.exports = ticketRoutes;
