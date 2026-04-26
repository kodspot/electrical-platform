'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { notifyAdmins, notifySupervisors, createNotification } = require('./notifications');
const { emailAdmins, escHtml } = require('../lib/email');
const { getAssignedSupervisorIds } = require('../services/assignment-resolver');

const ISSUE_TYPES = ['ELECTRICAL_FAULT', 'WIRING_ISSUE', 'POWER_OUTAGE', 'SHORT_CIRCUIT', 'LIGHT_NOT_WORKING', 'FAN_NOT_WORKING', 'AC_NOT_WORKING', 'SWITCH_SOCKET_ISSUE', 'OTHER'];

const MODULE_ISSUE_TYPES = {
  ele: ['ELECTRICAL_FAULT', 'WIRING_ISSUE', 'POWER_OUTAGE', 'SHORT_CIRCUIT', 'LIGHT_NOT_WORKING', 'FAN_NOT_WORKING', 'AC_NOT_WORKING', 'SWITCH_SOCKET_ISSUE', 'OTHER'],
  civil: ['STRUCTURAL_DAMAGE', 'PLUMBING_LEAK', 'PAINT_DAMAGE', 'CEILING_DAMAGE', 'FLOOR_DAMAGE', 'DOOR_WINDOW_ISSUE', 'WALL_CRACK', 'OTHER'],
  asset: ['ASSET_DAMAGED', 'ASSET_MISSING', 'ASSET_MALFUNCTION', 'OTHER'],
  complaints: ['NOISE', 'TEMPERATURE', 'STAFF_BEHAVIOUR', 'SAFETY_CONCERN', 'OTHER']
};

const ALL_ISSUE_TYPES = [...new Set(Object.values(MODULE_ISSUE_TYPES).flat())];

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
      enabledModules: location.org.enabledModules || ['ele']
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

    // Validate module
    const mod = data.module || 'ele';
    const allowedIssues = MODULE_ISSUE_TYPES[mod] || ISSUE_TYPES;
    if (!allowedIssues.includes(data.issueType)) {
      return reply.code(400).send({ error: 'Invalid issue type for module ' + mod });
    }

    // Sanitize phone — only keep digits, +, -, spaces
    if (data.guestPhone) {
      data.guestPhone = data.guestPhone.replace(/[^\d+\-\s()]/g, '').substring(0, 20);
    }

    // Look up location to get orgId
    const location = await prisma.location.findUnique({
      where: { id: data.locationId },
      select: { id: true, orgId: true, name: true, isActive: true, org: { select: { status: true } } }
    });

    if (!location || !location.isActive) {
      return reply.code(404).send({ error: 'Location not found' });
    }

    if (location.org.status !== 'ACTIVE') {
      return reply.code(410).send({ error: 'This facility is currently not accepting complaints' });
    }

    // Handle image upload with proper orgId
    if (imageUrl === '__pending__' && _pendingImageBuffer) {
      imageUrl = await uploadToR2(_pendingImageBuffer, _pendingImageMime, location.orgId);
    }

    // Map issue type to a readable title
    const ISSUE_LABELS = {
      // Electrical
      ELECTRICAL_FAULT: 'Electrical Fault',
      WIRING_ISSUE: 'Wiring Issue',
      POWER_OUTAGE: 'Power Outage',
      SHORT_CIRCUIT: 'Short Circuit',
      LIGHT_NOT_WORKING: 'Light Not Working',
      FAN_NOT_WORKING: 'Fan Not Working',
      AC_NOT_WORKING: 'AC Not Working',
      SWITCH_SOCKET_ISSUE: 'Switch / Socket Issue',
      BROKEN_EQUIPMENT: 'Broken Equipment',
      WATER_ISSUE: 'Water / Plumbing Issue',
      // Civil
      STRUCTURAL_DAMAGE: 'Structural Damage',
      PLUMBING_LEAK: 'Plumbing Leak',
      PAINT_DAMAGE: 'Paint Damage',
      CEILING_DAMAGE: 'Ceiling Damage',
      FLOOR_DAMAGE: 'Floor Damage',
      DOOR_WINDOW_ISSUE: 'Door / Window Issue',
      WALL_CRACK: 'Wall Crack',
      // Asset
      ASSET_DAMAGED: 'Asset Damaged',
      ASSET_MISSING: 'Asset Missing',
      ASSET_MALFUNCTION: 'Asset Malfunction',
      // Complaints
      NOISE: 'Noise Complaint',
      TEMPERATURE: 'Temperature Issue',
      STAFF_BEHAVIOUR: 'Staff Behaviour',
      SAFETY_CONCERN: 'Safety Concern',
      // Generic
      OTHER: 'Other Issue'
    };

    const title = (ISSUE_LABELS[data.issueType] || data.issueType) + ' — ' + location.name;

    // Compute complaint provenance (privacy-safe)
    const rawIp = request.ip || request.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
    const sourceIp = rawIp ? crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16) : null;
    const userAgent = (request.headers['user-agent'] || '').slice(0, 200) || null;

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

    const ticket = await prisma.ticket.create({
      data: {
        orgId: location.orgId,
        locationId: data.locationId,
        title,
        description: data.description || null,
        imageUrl: imageUrl && imageUrl !== '__pending__' ? imageUrl : null,
        priority: 'NORMAL',
        source: 'PUBLIC',
        module: mod,
        guestName: data.guestName || null,
        guestPhone: data.guestPhone || null,
        issueType: data.issueType,
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

    // Auto-assign to supervisors responsible for this location
    try {
      const supervisorIds = await getAssignedSupervisorIds(data.locationId, location.orgId);
      if (supervisorIds.length > 0) {
        await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedToId: supervisorIds[0] } });
        // Notify each assigned supervisor directly
        for (const supId of supervisorIds) {
          createNotification({
            orgId: location.orgId,
            userId: supId,
            type: 'public_complaint',
            title: 'New public complaint assigned',
            body: ticket.title,
            entityId: ticket.id,
            isUrgent: true
          }).catch(() => {});
        }
      }
    } catch (_) { /* non-fatal */ }

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: location.orgId,
        actorType: 'guest',
        actorId: data.guestName || 'anonymous',
        action: 'ticket_public_create',
        entityType: 'Ticket',
        entityId: ticket.id,
        newValue: { issueType: data.issueType, locationName: location.name, guestName: data.guestName }
      }
    });

    // Notify admins about new public complaint
    notifyAdmins(location.orgId, {
      type: 'public_complaint',
      title: 'New public complaint',
      body: ticket.title,
      entityId: ticket.id
    }).catch(() => {});

    // Notify supervisors about new public complaint
    notifySupervisors(location.orgId, {
      type: 'public_complaint',
      title: 'New public complaint',
      body: ticket.title,
      entityId: ticket.id
    }).catch(() => {});

    // Email admins about the new complaint
    emailAdmins(prisma, location.orgId, 'New Public Complaint',
      `<p><span class="label">Issue:</span> <span class="val">${escHtml(ticket.title)}</span></p>
       <p><span class="label">Location:</span> <span class="val">${escHtml(location.name)}</span></p>
       ${data.guestName ? `<p><span class="label">Guest:</span> <span class="val">${escHtml(data.guestName)}</span></p>` : ''}
       ${data.description ? `<p><span class="label">Details:</span> <span class="val">${escHtml(data.description)}</span></p>` : ''}
       <p style="margin-top:16px;color:#888;font-size:12px">Please log in to the dashboard to review and assign this ticket.</p>`
    ).catch(() => {});

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
        location: { select: { name: true } }
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
      await prisma.ticket.update({
        where: { reviewToken: token },
        data: {
          reviewStatus: 'CONFIRMED',
          reviewNote: data.note?.trim() || null,
          reviewedAt: now,
          status: 'CLOSED'
        }
      });

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

    // REJECT: reopen ticket, clear assignee so it goes back to pool
    await prisma.ticket.update({
      where: { reviewToken: token },
      data: {
        reviewStatus: 'REJECTED',
        reviewNote: data.note?.trim() || null,
        reviewedAt: now,
        status: 'OPEN',
        assignedToId: null
      }
    });

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

    return { success: true, message: 'Your feedback has been recorded. The issue will be re-opened for further attention.' };
  });
}

module.exports = publicRoutes;
