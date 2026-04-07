'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole, requireModule } = require('../middleware/auth');

async function cleaningRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('hk'));

  // Default shift windows (used when no org-specific config exists)
  const DEFAULT_SHIFTS = {
    MORNING:   { startHour: 6, startMin: 0, endHour: 14, endMin: 0 },
    AFTERNOON: { startHour: 14, startMin: 0, endHour: 22, endMin: 0 },
    NIGHT:     { startHour: 22, startMin: 0, endHour: 6, endMin: 0 },
    GENERAL:   { startHour: 0, startMin: 0, endHour: 0, endMin: 0 }
  };

  // Cache org shift configs (TTL 5 min)
  const _shiftCache = {};
  async function getShiftConfigs(orgId) {
    const cached = _shiftCache[orgId];
    if (cached && Date.now() - cached.ts < 300000) return cached.data;
    const rows = await prisma.shiftConfig.findMany({ where: { orgId } });
    const configs = { ...DEFAULT_SHIFTS };
    for (const r of rows) {
      configs[r.shift] = { startHour: r.startHour, startMin: r.startMin, endHour: r.endHour, endMin: r.endMin };
    }
    _shiftCache[orgId] = { data: configs, ts: Date.now() };
    return configs;
  }

  function timeInMinutes(h, m) { return h * 60 + m; }

  function getExpectedShiftFromConfig(configs) {
    const now = new Date();
    const nowMins = timeInMinutes(now.getHours(), now.getMinutes());
    for (const shift of ['MORNING', 'AFTERNOON', 'NIGHT']) {
      const c = configs[shift];
      const start = timeInMinutes(c.startHour, c.startMin);
      const end = timeInMinutes(c.endHour, c.endMin);
      if (end > start) {
        // Normal range (e.g. 6:00-14:00)
        if (nowMins >= start && nowMins < end) return shift;
      } else if (end < start) {
        // Overnight range (e.g. 22:00-6:00)
        if (nowMins >= start || nowMins < end) return shift;
      }
    }
    return 'GENERAL';
  }

  function isWithinShiftWindowConfig(shift, configs) {
    if (shift === 'GENERAL') return true;
    return shift === getExpectedShiftFromConfig(configs);
  }

  // Check if a shift's time window has already started (rejects future shifts)
  function hasShiftStarted(shift, configs) {
    if (shift === 'GENERAL') return true;
    const c = configs[shift];
    if (!c) return true;
    const now = new Date();
    const nowMins = timeInMinutes(now.getHours(), now.getMinutes());
    const startMins = timeInMinutes(c.startHour, c.startMin);
    const endMins = timeInMinutes(c.endHour, c.endMin);
    if (endMins > startMins) {
      return nowMins >= startMins;
    } else {
      // Overnight shift (e.g. 22:00-6:00)
      return nowMins >= startMins || nowMins < endMins;
    }
  }

  // Submit cleaning record (Supervisor) — multipart form
  fastify.post('/cleaning-records', {
    preHandler: [requireRole('SUPERVISOR')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;

    const fieldValue = (f) => {
      if (f == null) return undefined;
      if (typeof f === 'object' && 'value' in f) return f.value;
      return f;
    };

    const locationId = fieldValue(request.body.locationId);
    const workerIdsRaw = fieldValue(request.body.workerIds);
    const shift = fieldValue(request.body.shift) || 'GENERAL';
    const notes = fieldValue(request.body.notes);
    const lateReason = fieldValue(request.body.lateReason);

    if (!locationId) return reply.code(400).send({ error: 'locationId is required' });

    // Validate location belongs to same org and is active
    const location = await prisma.location.findFirst({
      where: { id: locationId, orgId, isActive: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found or inactive' });

    // Parse worker IDs
    let workerIdList = [];
    try {
      workerIdList = typeof workerIdsRaw === 'string' ? JSON.parse(workerIdsRaw) : (workerIdsRaw || []);
    } catch { /* array parse failed */ }

    if (!Array.isArray(workerIdList) || workerIdList.length === 0) {
      return reply.code(400).send({ error: 'At least one worker must be selected' });
    }

    // Validate workers belong to same org
    const workers = await prisma.worker.findMany({
      where: { id: { in: workerIdList }, orgId, isActive: true }
    });
    if (workers.length !== workerIdList.length) {
      return reply.code(400).send({ error: 'One or more workers not found or inactive' });
    }

    // Validate shift
    const validShifts = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'];
    if (!validShifts.includes(shift)) {
      return reply.code(400).send({ error: 'Invalid shift value' });
    }

    // Block future shifts: cannot submit cleaning for a shift that hasn't started yet
    const shiftConfigs = await getShiftConfigs(orgId);
    if (!hasShiftStarted(shift, shiftConfigs)) {
      return reply.code(400).send({
        error: 'Cannot submit cleaning for ' + shift + ' shift — it has not started yet.',
        code: 'FUTURE_SHIFT'
      });
    }

    // Duplicate submission guard (configurable per org)
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { allowDuplicateCleaning: true }
    });

    if (!org?.allowDuplicateCleaning) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const existingRecord = await prisma.cleaningRecord.findFirst({
        where: {
          orgId,
          locationId,
          shift,
          cleanedAt: { gte: todayStart, lte: todayEnd }
        },
        select: {
          id: true,
          cleanedAt: true,
          supervisor: { select: { name: true } }
        }
      });
      if (existingRecord) {
        const time = existingRecord.cleanedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        return reply.code(409).send({
          error: `This location was already cleaned for ${shift} shift today at ${time} by ${existingRecord.supervisor?.name || 'a supervisor'}.`,
          code: 'DUPLICATE_CLEANING',
          existingRecordId: existingRecord.id
        });
      }
    }

    // Handle image upload(s)
    const imageField = request.body.image;
    if (!imageField) return reply.code(400).send({ error: 'At least one image is required' });

    const files = Array.isArray(imageField) ? imageField : [imageField];
    const uploadedUrls = [];
    let uploadFailures = 0;

    for (const file of files) {
      if (!file.mimetype) continue;
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(file.mimetype)) {
        return reply.code(400).send({ error: 'Invalid image type. Only JPG, PNG, WebP allowed.' });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        return reply.code(400).send({ error: 'Image too large. Max 5MB per file.' });
      }

      if (!validateImageBuffer(buffer, file.mimetype)) {
        return reply.code(400).send({ error: 'Invalid image file' });
      }

      try {
        const url = await uploadToR2(buffer, file.mimetype, orgId);
        uploadedUrls.push(url);
      } catch (uploadErr) {
        uploadFailures++;
        fastify.log.error({ err: uploadErr, orgId, locationId }, 'R2 image upload failed — continuing with remaining images');
      }
    }

    if (uploadedUrls.length === 0) {
      return reply.code(502).send({ error: 'Image upload failed. Please check your network and try again.', code: 'UPLOAD_FAILED' });
    }

    // Shift validation: detect if submission is outside the shift window
    const expectedShift = getExpectedShiftFromConfig(shiftConfigs);
    const isLate = !isWithinShiftWindowConfig(shift, shiftConfigs);

    // If submitting outside the shift window, lateReason is required
    if (isLate && (!lateReason || !lateReason.trim())) {
      return reply.code(400).send({
        error: 'You are submitting for ' + shift + ' shift outside the allowed time window (' + expectedShift + ' shift is currently active). Please provide a reason.',
        code: 'SHIFT_MISMATCH',
        expectedShift
      });
    }

    const record = await prisma.cleaningRecord.create({
      data: {
        orgId,
        locationId,
        supervisorId: request.user.id,
        shift,
        expectedShift: isLate ? expectedShift : null,
        isLate,
        lateReason: isLate ? (lateReason || '').trim() : null,
        notes: notes || null,
        workers: { connect: workerIdList.map(id => ({ id })) },
        images: {
          create: uploadedUrls.map(url => ({ imageUrl: url }))
        }
      },
      include: {
        location: { select: { id: true, name: true, type: true } },
        supervisor: { select: { id: true, name: true } },
        workers: { select: { id: true, name: true } },
        images: { select: { id: true, imageUrl: true, createdAt: true } }
      }
    });

    // If some images failed upload, include a warning (record still saved)
    if (uploadFailures > 0) {
      return { ...record, _warning: `${uploadFailures} image(s) failed to upload. The cleaning record was saved with ${uploadedUrls.length} image(s).` };
    }

    return record;
  });

  // List cleaning records
  fastify.get('/cleaning-records', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { locationId, workerId, supervisorId, shift, from, to, status, page, limit, search, isLate, sort } = request.query;

    const where = { orgId };
    if (locationId) where.locationId = locationId;
    if (shift) where.shift = shift;
    if (status) where.status = status;
    if (workerId) where.workers = { some: { id: workerId } };
    if (isLate === 'true') where.isLate = true;
    if (isLate === 'false') where.isLate = false;

    // Search by location name
    if (search && search.trim()) {
      where.location = { name: { contains: search.trim(), mode: 'insensitive' } };
    }

    // Admin can filter by supervisorId; supervisors see only own records
    if (request.user.role === 'SUPERVISOR') {
      where.supervisorId = request.user.id;
    } else if (supervisorId) {
      where.supervisorId = supervisorId;
    }

    if (from || to) {
      where.cleanedAt = {};
      if (from) where.cleanedAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        // If 'to' is just a date (no time), set to end of day
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.cleanedAt.lte = toDate;
      }
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    // Determine sort order
    let orderBy = { cleanedAt: 'desc' };
    if (sort === 'oldest') orderBy = { cleanedAt: 'asc' };
    if (sort === 'location') orderBy = [{ location: { name: 'asc' } }, { cleanedAt: 'desc' }];

    const [records, total, flaggedCount, lateCount] = await Promise.all([
      prisma.cleaningRecord.findMany({
        where,
        orderBy,
        take,
        skip,
        include: {
          location: { select: { id: true, name: true, type: true } },
          supervisor: { select: { id: true, name: true } },
          workers: { select: { id: true, name: true } },
          images: { select: { id: true, imageUrl: true } },
          _count: { select: { images: true } }
        }
      }),
      prisma.cleaningRecord.count({ where }),
      prisma.cleaningRecord.count({ where: { ...where, status: 'FLAGGED' } }),
      prisma.cleaningRecord.count({ where: { ...where, isLate: true } })
    ]);

    const pages = Math.ceil(total / take);
    return { records, total, page: Math.floor(skip / take) + 1, pages, totalPages: pages, flaggedCount, lateCount };
  });

  // Get single cleaning record
  fastify.get('/cleaning-records/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const { id } = request.params;
    const record = await prisma.cleaningRecord.findFirst({
      where: { id, orgId: request.user.orgId },
      include: {
        location: { select: { id: true, name: true, type: true, qrCode: true } },
        supervisor: { select: { id: true, name: true, email: true } },
        workers: { select: { id: true, name: true, phone: true } },
        images: { select: { id: true, imageUrl: true, createdAt: true } }
      }
    });
    if (!record) return reply.code(404).send({ error: 'Record not found' });
    return record;
  });

  // Export cleaning records as CSV (Admin only)
  fastify.get('/cleaning-records/export', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { locationId, shift, from, to, status, isLate } = request.query;

    const where = { orgId };
    if (locationId) where.locationId = locationId;
    if (shift) where.shift = shift;
    if (status) where.status = status;
    if (isLate === 'true') where.isLate = true;
    if (from || to) {
      where.cleanedAt = {};
      if (from) where.cleanedAt.gte = new Date(from);
      if (to) { const d = new Date(to); if (to.length === 10) d.setHours(23, 59, 59, 999); where.cleanedAt.lte = d; }
    }

    const records = await prisma.cleaningRecord.findMany({
      where,
      orderBy: { cleanedAt: 'desc' },
      take: 5000, // Safety cap
      include: {
        location: { select: { name: true, type: true } },
        supervisor: { select: { name: true } },
        workers: { select: { name: true } }
      }
    });

    // Build CSV
    const esc = (v) => {
      if (v == null) return '';
      let s = String(v);
      // Guard against CSV formula injection
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const header = 'Date,Time,Location,Type,Shift,Supervisor,Workers,Status,Late,Late Reason,Notes';
    const rows = records.map(r => {
      const d = new Date(r.cleanedAt);
      return [
        d.toLocaleDateString('en-IN'),
        d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        esc(r.location?.name),
        esc(r.location?.type),
        r.shift,
        esc(r.supervisor?.name),
        esc(r.workers?.map(w => w.name).join('; ')),
        r.status,
        r.isLate ? 'Yes' : 'No',
        esc(r.lateReason),
        esc(r.notes)
      ].join(',');
    });

    const csv = [header, ...rows].join('\n');
    const filename = `cleaning-records-${new Date().toISOString().split('T')[0]}.csv`;

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  // Flag / unflag a cleaning record (Admin only)
  fastify.patch('/cleaning-records/:id/flag', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const { id } = request.params;
    const record = await prisma.cleaningRecord.findFirst({
      where: { id, orgId: request.user.orgId }
    });
    if (!record) return reply.code(404).send({ error: 'Record not found' });

    const newStatus = record.status === 'FLAGGED' ? 'SUBMITTED' : 'FLAGGED';
    const reason = request.body && typeof request.body.reason === 'string' ? request.body.reason.trim() : null;

    const updated = await prisma.cleaningRecord.update({
      where: { id },
      data: {
        status: newStatus,
        flagReason: newStatus === 'FLAGGED' ? (reason || null) : null
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: newStatus === 'FLAGGED' ? 'cleaning_record_flagged' : 'cleaning_record_unflagged',
        entityType: 'CleaningRecord',
        entityId: id,
        newValue: newStatus === 'FLAGGED' && reason ? { reason } : undefined
      }
    });

    return updated;
  });

  // ── Shift Config: Get org shift timings ──
  fastify.get('/shift-config', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const rows = await prisma.shiftConfig.findMany({ where: { orgId } });
    const savedShifts = new Set(rows.map(r => r.shift));
    const configs = { ...DEFAULT_SHIFTS };
    for (const r of rows) {
      configs[r.shift] = { startHour: r.startHour, startMin: r.startMin, endHour: r.endHour, endMin: r.endMin };
    }
    return ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'].map(shift => ({
      shift,
      startHour: configs[shift].startHour,
      startMin: configs[shift].startMin,
      endHour: configs[shift].endHour,
      endMin: configs[shift].endMin,
      isDefault: !savedShifts.has(shift)
    }));
  });

  // ── Shift Config: Update org shift timings (Admin only) ──
  fastify.put('/shift-config', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const schema = z.array(z.object({
      shift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL']),
      startHour: z.number().int().min(0).max(23),
      startMin: z.number().int().min(0).max(59).default(0),
      endHour: z.number().int().min(0).max(23),
      endMin: z.number().int().min(0).max(59).default(0)
    }));

    const configs = schema.parse(request.body);

    // Upsert each shift config
    const results = [];
    for (const c of configs) {
      const result = await prisma.shiftConfig.upsert({
        where: { orgId_shift: { orgId, shift: c.shift } },
        update: { startHour: c.startHour, startMin: c.startMin, endHour: c.endHour, endMin: c.endMin },
        create: { orgId, shift: c.shift, startHour: c.startHour, startMin: c.startMin, endHour: c.endHour, endMin: c.endMin }
      });
      results.push(result);
    }

    // Invalidate cache
    delete _shiftCache[orgId];

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'shift_config_updated',
        entityType: 'ShiftConfig',
        newValue: configs
      }
    });

    return results;
  });

  // ── Org Cleaning Settings: Get ──
  fastify.get('/cleaning-settings', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const org = await prisma.organization.findUnique({
      where: { id: request.user.orgId },
      select: { allowDuplicateCleaning: true }
    });
    return { allowDuplicateCleaning: org?.allowDuplicateCleaning ?? false };
  });

  // ── Org Cleaning Settings: Update ──
  fastify.patch('/cleaning-settings', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const schema = z.object({
      allowDuplicateCleaning: z.boolean()
    });
    const data = schema.parse(request.body);

    const updated = await prisma.organization.update({
      where: { id: request.user.orgId },
      data: { allowDuplicateCleaning: data.allowDuplicateCleaning },
      select: { allowDuplicateCleaning: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId: request.user.orgId,
        actorType: 'admin',
        actorId: request.user.id,
        action: 'cleaning_settings_updated',
        entityType: 'Organization',
        newValue: data
      }
    });

    return updated;
  });
}

module.exports = cleaningRoutes;
