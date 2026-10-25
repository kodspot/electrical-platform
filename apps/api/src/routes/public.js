'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { notifyAdmins, notifySupervisors, notifyWorkers, createNotification } = require('./notifications');
const { notify } = require('../services/notification-service');
const { escHtml } = require('../lib/email');
const { getAssignedSupervisorIds, getAssignedWorkerIds, getLocationBreadcrumb } = require('../services/assignment-resolver');
const { normalizeEnabledModules, isModuleEnabled } = require('../services/module-policy');
const { STALE_TICKET_ERROR, updateTicketIfUnchanged } = require('../services/ticket-status');
const {
  VALID_MODULES,
  DEFAULT_MODULE_ISSUES,
  normalizeModuleCode,
  humanizeIssueKey,
  getComplaintCategoriesForLocation
} = require('../services/complaint-categories');

function getDefaultIssueKeys(moduleCode) {
  const mod = normalizeModuleCode(moduleCode);
  return (DEFAULT_MODULE_ISSUES[mod] || []).map((item) => item.key);
}

async function publicRoutes(fastify, opts) {

  // ── Public: Get location info by QR code (no auth required) ──
  // Returns minimal location info for the complaint form
  fastify.get('/public/location/:code', async (request, reply) => {
    const code = request.params.code.toUpperCase().trim();
    if (!code || code.length < 4 || code.length > 20) {
      return reply.code(400).send({ error: 'Invalid code' });
    }

    const location = await prisma.location.findUnique({
      where: { qrCode: code },
      select: {
        id: true,
        name: true,
        type: true,
        orgId: true,
        isActive: true,
        parent: { select: { name: true } },
        org: { select: { name: true, status: true, slug: true, enabledModules: true } }
      }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    if (location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    return {
      id: location.id,
      name: location.name,
      type: location.type,
      parentName: location.parent?.name || null,
      orgName: location.org.name,
      orgSlug: location.org.slug,
      enabledModules: normalizeEnabledModules(location.org.enabledModules)
    };
  });

  // ── Public: Get active child locations for a parent location (no auth required) ──
  fastify.get('/public/location-children/:locationId', {
    config: {
      rateLimit: {
        max: 40,
        timeWindow: 60000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const schema = z.object({
      locationId: z.string().uuid()
    });
    const { locationId } = schema.parse(request.params || {});

    const parent = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        orgId: true,
        name: true,
        type: true,
        isActive: true,
        parent: { select: { id: true, name: true, type: true } },
        org: { select: { status: true } }
      }
    });

    if (!parent || !parent.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }
    if (!parent.org || parent.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    const children = await prisma.location.findMany({
      where: {
        orgId: parent.orgId,
        parentId: parent.id,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        type: true,
        sortOrder: true,
        parent: { select: { id: true, name: true, type: true } }
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });

    return {
      parent: {
        id: parent.id,
        name: parent.name,
        type: parent.type,
        parentName: parent.parent?.name || null
      },
      children
    };
  });

  // ── Public: Get complaint categories for a location/module (no auth required) ──
  fastify.get('/public/complaint-categories/:locationId', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 60000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const schema = z.object({
      locationId: z.string().uuid()
    });
    const querySchema = z.object({
      module: z.string().optional()
    });

    const { locationId } = schema.parse(request.params || {});
    const { module } = querySchema.parse(request.query || {});
    const mod = normalizeModuleCode(module || 'ele');

    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        orgId: true,
        isActive: true,
        org: { select: { status: true } }
      }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }
    if (!location.org || location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    const categories = await getComplaintCategoriesForLocation({
      orgId: location.orgId,
      locationId,
      module: mod,
      includeDefaults: true
    });

    return {
      module: mod,
      locationId,
      hostelLocationId: categories.hostelLocationId,
      categories: categories.categories
    };
  });

  // ── Public: Submit a complaint (no auth required) ──
  // Stricter rate limiting for anonymous complaint submission
  fastify.post('/public/complaint', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    let data, imageUrl = null;
    let _pendingImageBuffer = null, _pendingImageMime = null;

    if (request.isMultipart()) {
      const fieldValue = (f) => {
        if (f == null) return undefined;
        if (typeof f === 'object' && 'value' in f) return f.value;
        return f;
      };

      data = {
        locationId: fieldValue(request.body.locationId),
        issueType: fieldValue(request.body.issueType),
        module: fieldValue(request.body.module) || 'ele',
        description: fieldValue(request.body.description)?.trim() || null,
        guestName: fieldValue(request.body.guestName)?.trim() || null,
        guestPhone: fieldValue(request.body.guestPhone)?.trim() || null
      };

      const imageFile = request.body.image;
      if (imageFile && imageFile.mimetype) {
        const file = Array.isArray(imageFile) ? imageFile[0] : imageFile;
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
          return reply.code(400).send({ error: 'Invalid image type. Use JPEG, PNG or WebP.' });
        }
        const buffer = await file.toBuffer();
        if (buffer.length > 5 * 1024 * 1024) {
          return reply.code(400).send({ error: 'Image too large. Max 5MB.' });
        }
        if (!validateImageBuffer(buffer, file.mimetype)) {
          return reply.code(400).send({ error: 'Invalid image file' });
        }
        // Store buffer for upload after we get orgId from location
        _pendingImageBuffer = buffer;
        _pendingImageMime = file.mimetype;
        imageUrl = '__pending__';
      }
    } else {
      const schema = z.object({
        locationId: z.string().uuid(),
        issueType: z.string(),
        module: z.string().max(20).default('ele'),
        description: z.string().max(500).optional(),
        guestName: z.string().max(100).optional(),
        guestPhone: z.string().max(20).optional()
      });
      data = schema.parse(request.body);
    }

    // Validate required fields
    if (!data.locationId || !data.issueType) {
      return reply.code(400).send({ error: 'locationId and issueType are required' });
    }

    // Validate locationId format (UUID)
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(data.locationId)) {
      return reply.code(400).send({ error: 'Invalid locationId format' });
    }

    // Sanitize phone — only keep digits, +, -, spaces
    if (data.guestPhone) {
      data.guestPhone = data.guestPhone.replace(/[^\d+\-\s()]/g, '').substring(0, 20);
    }

    // Look up location to get orgId
    const location = await prisma.location.findUnique({
      where: { id: data.locationId },
      select: { id: true, orgId: true, name: true, isActive: true, org: { select: { status: true, enabledModules: true } } }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    if (location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    // Compute complaint provenance (privacy-safe) and enforce abuse detection
    // as early as possible — before category validation, image upload, or
    // ticket creation — so a rejected submission never wastes an R2 upload
    // or any further work. Peppered with IP_HASH_PEPPER (HMAC-SHA256) when
    // configured; falls back to a plain digest, identical to pre-WP11
    // behavior, when it isn't set. Duplicate detection only ever compares
    // submissions from the last 30 minutes, so a change in hash scheme never
    // needs to reconcile against older, differently-hashed rows. [WP11]
    const rawIp = request.ip || request.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
    const sourceIp = rawIp
      ? crypto.createHmac('sha256', process.env.IP_HASH_PEPPER || '').update(rawIp).digest('hex').slice(0, 16)
      : null;

    // Risk scoring: duplicate detection within last 30 min from same IP hash + same location
    let riskScore = 0;
    if (sourceIp) {
      const recentCount = await prisma.ticket.count({
        where: {
          orgId: location.orgId,
          locationId: data.locationId,
          source: 'PUBLIC',
          sourceIp,
          createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }
        }
      });
      if (recentCount >= 3) riskScore = 80;
      else if (recentCount >= 1) riskScore = 40;
    }

    // Enforce the risk score instead of only recording it — this closes the
    // exact gap audit finding H8 described. The threshold (80 = 3+ identical-
    // location submissions from the same IP within 30 minutes) reuses the
    // scoring exactly as already computed above; it does not introduce a new
    // scoring scheme. Lower-risk submissions (40) are still recorded on the
    // ticket for staff triage but are not blocked, so a single legitimate
    // repeat report (e.g. two guests behind the same NAT/hostel WiFi) is
    // never rejected. [WP11]
    if (riskScore >= 80) {
      return reply.code(429).send({
        error: 'Too many complaints submitted recently from this connection for this location. Please wait before submitting again.'
      });
    }

    const mod = normalizeModuleCode(data.module || 'ele');
    if (!VALID_MODULES.includes(mod)) {
      return reply.code(400).send({ error: 'Invalid module' });
    }
    // The same rule POST /tickets enforces for staff: no ticket in a module the
    // organization has not enabled (the QR page offers only its enabled modules, but a
    // page left open while a module is switched off, or a crafted request, does not). [BUG-0020]
    if (!isModuleEnabled(location.org, mod)) {
      return reply.code(400).send({ error: 'This facility does not take complaints for that service' });
    }

    const issueType = String(data.issueType || '').trim().toUpperCase();
    const categoryBundle = await getComplaintCategoriesForLocation({
      orgId: location.orgId,
      locationId: data.locationId,
      module: mod,
      includeDefaults: true
    });
    const allowedIssues = categoryBundle.categories.length
      ? categoryBundle.categories.map((cat) => cat.key)
      : getDefaultIssueKeys(mod);

    if (!allowedIssues.includes(issueType)) {
      return reply.code(400).send({ error: 'Invalid issue type for module ' + mod });
    }

    // Handle image upload with proper orgId
    if (imageUrl === '__pending__' && _pendingImageBuffer) {
      imageUrl = await uploadToR2(_pendingImageBuffer, _pendingImageMime, location.orgId);
    }

    const chosenCategory = categoryBundle.categories.find((cat) => cat.key === issueType);
    const issueLabel = chosenCategory?.label || humanizeIssueKey(issueType);
    const title = issueLabel + ' — ' + location.name;
    const userAgent = (request.headers['user-agent'] || '').slice(0, 200) || null;

    // Resolve auto-assignment before creating the ticket so it's set in the
    // same write, instead of a separate update afterward — a complaint that
    // should have been auto-assigned to a warden but wasn't (because a
    // second write failed) is a real workflow-integrity gap. [WP9]
    let supervisorIds = [];
    let supervisorLookupError = null;
    try {
      supervisorIds = await getAssignedSupervisorIds(data.locationId, location.orgId);
    } catch (err) { supervisorLookupError = err; }

    // Every notification step below stays fire-and-forget (a failed ring must never fail the
    // complaint), but is no longer silent: one warn line per failed step, with no URL, token
    // or email in it. [WP-H F4]
    const warnStep = (ticketId, step) => (err) => request.log.warn(
      { ticketId, step, err: String((err && err.message) || err).slice(0, 200) },
      'notification step failed'
    );

    const ticket = await prisma.ticket.create({
      data: {
        orgId: location.orgId,
        locationId: data.locationId,
        assignedToId: supervisorIds[0] || null,
        title,
        description: data.description || null,
        imageUrl: imageUrl && imageUrl !== '__pending__' ? imageUrl : null,
        priority: 'NORMAL',
        source: 'PUBLIC',
        module: mod,
        guestName: data.guestName || null,
        guestPhone: data.guestPhone || null,
        issueType,
        sourceIp,
        userAgent,
        riskScore,
        slaDeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h SLA for public complaints
      },
      select: {
        id: true,
        title: true,
        issueType: true,
        status: true,
        createdAt: true,
        location: { select: { name: true } }
      }
    });
    if (supervisorLookupError) warnStep(ticket.id, 'resolve_supervisors')(supervisorLookupError);

    // Build a rich notification body with location breadcrumb so the
    // electrician knows exactly where to go without opening the app.
    let locationCrumb = location.name;
    try { locationCrumb = await getLocationBreadcrumb(data.locationId) || location.name; } catch (err) { warnStep(ticket.id, 'location_breadcrumb')(err); }
    const notifBody = `${ticket.title} — ${locationCrumb}`;

    // Notify each assigned supervisor directly (all of them, not just the
    // one auto-assigned above).
    for (const supId of supervisorIds) {
      createNotification({
        orgId: location.orgId,
        userId: supId,
        type: 'public_complaint',
        title: 'New public complaint assigned',
        body: notifBody,
        entityId: ticket.id,
        isUrgent: true
      }).catch(warnStep(ticket.id, 'notify_assigned_supervisor'));
    }

    // Ring the electricians covering this location immediately so they can
    // start moving while the warden triages. Notification goes to in-app bell
    // + live SSE worker-stream (instant ring on the electrician app).
    try {
      const workerIds = await getAssignedWorkerIds(data.locationId, location.orgId);
      if (workerIds.length > 0) {
        await notifyWorkers(location.orgId, workerIds, {
          type: 'public_complaint',
          title: 'New complaint at your location',
          body: notifBody,
          entityId: ticket.id,
          isUrgent: true
        });
      }
    } catch (err) { warnStep(ticket.id, 'notify_workers')(err); }

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: location.orgId,
        actorType: 'guest',
        actorId: data.guestName || 'anonymous',
        action: 'ticket_public_create',
        entityType: 'Ticket',
        entityId: ticket.id,
        newValue: { issueType, locationName: location.name, guestName: data.guestName }
      }
    });

    // Notify admins about new public complaint (in-app + paired email)
    notify({
      orgId: location.orgId,
      to: { admins: true },
      type: 'public_complaint',
      title: 'New public complaint',
      body: notifBody,
      entityId: ticket.id,
      isUrgent: true,
      email: {
        toAdmins: true,
        subject: 'New Public Complaint',
        html: `<p><span class="label">Issue:</span> <span class="val">${escHtml(ticket.title)}</span></p>
       <p><span class="label">Location:</span> <span class="val">${escHtml(location.name)}</span></p>
       ${data.guestName ? `<p><span class="label">Guest:</span> <span class="val">${escHtml(data.guestName)}</span></p>` : ''}
       ${data.description ? `<p><span class="label">Details:</span> <span class="val">${escHtml(data.description)}</span></p>` : ''}
       <p style="margin-top:16px;color:#888;font-size:12px">Please log in to the dashboard to review and assign this ticket.</p>`
      }
    }).catch(warnStep(ticket.id, 'notify_admins'));

    // Notify the org's other supervisors (no paired email). Supervisors assigned to this
    // location already received the direct "assigned" notification above, so they are
    // excluded here — one notification each, not two. [WP-H F3]
    notifySupervisors(location.orgId, {
      type: 'public_complaint',
      title: 'New public complaint',
      body: notifBody,
      entityId: ticket.id,
      isUrgent: true
    }, { excludeUserIds: supervisorIds }).catch(warnStep(ticket.id, 'notify_supervisors'));

    return {
      success: true,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        location: ticket.location.name,
        createdAt: ticket.createdAt
      }
    };
  });

  // ── Public: Get review page data (no auth required) ──
  fastify.get('/public/review/:token', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const { token } = request.params;
    if (!token || token.length !== 64) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { reviewToken: token },
      select: {
        id: true,
        title: true,
        issueType: true,
        status: true,
        source: true,
        resolvedImageUrl: true,
        resolvedNote: true,
        resolvedAt: true,
        reviewStatus: true,
        reviewExpiresAt: true,
        reviewedAt: true,
        createdAt: true,
        location: { select: { name: true, type: true } },
        org: { select: { name: true } }
      }
    });

    if (!ticket) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    // Already reviewed
    if (ticket.reviewStatus !== 'PENDING') {
      return {
        status: 'already_reviewed',
        reviewStatus: ticket.reviewStatus,
        reviewedAt: ticket.reviewedAt
      };
    }

    // Expired
    if (ticket.reviewExpiresAt && new Date() > ticket.reviewExpiresAt) {
      // Auto-close
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: { reviewStatus: 'CONFIRMED', status: 'CLOSED', reviewedAt: new Date() }
      });
      return {
        status: 'expired',
        message: 'This review link has expired. The resolution has been automatically accepted.'
      };
    }

    return {
      status: 'pending',
      ticket: {
        title: ticket.title,
        issueType: ticket.issueType,
        resolvedImageUrl: ticket.resolvedImageUrl,
        resolvedNote: ticket.resolvedNote,
        resolvedAt: ticket.resolvedAt,
        createdAt: ticket.createdAt,
        locationName: ticket.location.name,
        locationType: ticket.location.type,
        orgName: ticket.org.name
      },
      expiresAt: ticket.reviewExpiresAt
    };
  });

  // ── Public: Submit review (confirm/reject resolution) ──
  fastify.post('/public/review/:token', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 900000,
        keyGenerator: (req) => req.ip
      }
    }
  }, async (request, reply) => {
    const { token } = request.params;
    if (!token || token.length !== 64) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    const schema = z.object({
      action: z.enum(['CONFIRM', 'REJECT']),
      note: z.string().max(500).optional()
    });

    let data;
    try {
      data = schema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'Invalid request. action must be CONFIRM or REJECT.' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { reviewToken: token },
      select: {
        id: true,
        orgId: true,
        title: true,
        status: true,
        reviewStatus: true,
        reviewExpiresAt: true,
        assignedToId: true,
        location: { select: { name: true } },
        resolvedWorkers: { select: { id: true } }
      }
    });

    if (!ticket) {
      return reply.code(404).send({ error: 'Invalid review link' });
    }

    // Already reviewed
    if (ticket.reviewStatus !== 'PENDING') {
      return reply.code(400).send({ error: 'This resolution has already been reviewed.' });
    }

    // Expired
    if (ticket.reviewExpiresAt && new Date() > ticket.reviewExpiresAt) {
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: { reviewStatus: 'CONFIRMED', status: 'CLOSED', reviewedAt: new Date() }
      });
      return reply.code(400).send({ error: 'This review link has expired. The resolution has been automatically accepted.' });
    }

    const now = new Date();

    if (data.action === 'CONFIRM') {
      // Only if the ticket and its review are still as read: a supervisor reopening it at the
      // same moment withdraws the review instead of both landing. [BUG-0038]
      const confirmed = await updateTicketIfUnchanged(prisma, ticket, {
        where: { reviewToken: token, reviewStatus: 'PENDING' },
        data: {
          reviewStatus: 'CONFIRMED',
          reviewNote: data.note?.trim() || null,
          reviewedAt: now,
          status: 'CLOSED'
        }
      });
      if (!confirmed) return reply.code(409).send({ error: STALE_TICKET_ERROR });

      await prisma.auditLog.create({
        data: {
          orgId: ticket.orgId,
          actorType: 'guest',
          action: 'ticket_review_confirmed',
          entityType: 'Ticket',
          entityId: ticket.id,
          newValue: { reviewStatus: 'CONFIRMED' }
        }
      });

      return { success: true, message: 'Thank you for confirming the resolution!' };
    }

    // REJECT: reopen ticket, clear assignee so it goes back to pool. The electricians who
    // resolved it are disconnected too, as the supervisor's reopen does: still connected, the
    // ticket stayed out of their pool and their app showed it "Done" with no way to pick it
    // up again. The resolution itself (photo, note) and the guest's verdict stay. [BUG-0026]
    const resolverIds = (ticket.resolvedWorkers || []).map((w) => w.id);
    const rejected = await updateTicketIfUnchanged(prisma, ticket, {
      where: { reviewToken: token, reviewStatus: 'PENDING' },
      data: {
        reviewStatus: 'REJECTED',
        reviewNote: data.note?.trim() || null,
        reviewedAt: now,
        status: 'OPEN',
        assignedToId: null,
        resolvedWorkers: { set: [] }
      }
    });
    if (!rejected) return reply.code(409).send({ error: STALE_TICKET_ERROR });

    await prisma.auditLog.create({
      data: {
        orgId: ticket.orgId,
        actorType: 'guest',
        action: 'ticket_review_rejected',
        entityType: 'Ticket',
        entityId: ticket.id,
        newValue: { reviewStatus: 'REJECTED', reviewNote: data.note || null }
      }
    });

    // Notify admins about rejection
    notifyAdmins(ticket.orgId, {
      type: 'ticket_review_rejected',
      title: 'Resolution rejected by guest',
      body: ticket.title + (ticket.location ? ' — ' + ticket.location.name : ''),
      entityId: ticket.id
    }).catch(() => {});

    // Notify the supervisor who resolved it
    if (ticket.assignedToId) {
      createNotification({
        orgId: ticket.orgId,
        userId: ticket.assignedToId,
        type: 'ticket_review_rejected',
        title: 'Guest rejected your resolution',
        body: ticket.title + (ticket.location ? ' — ' + ticket.location.name : ''),
        entityId: ticket.id
      }).catch(() => {});
    }

    // ...and tell them, with the guest's words. [BUG-0026]
    notify({
      orgId: ticket.orgId,
      to: { workerIds: resolverIds },
      type: 'ticket_review_rejected',
      title: 'The guest says it is not fixed',
      body: ticket.title + (data.note?.trim() ? ' — ' + data.note.trim() : ''),
      entityId: ticket.id
    }).catch(() => {});

    return { success: true, message: 'Your feedback has been recorded. The issue will be re-opened for further attention.' };
  });
}

module.exports = publicRoutes;
