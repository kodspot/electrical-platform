'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { uploadToR2 } = require('../lib/r2');
const { validateImageBuffer } = require('../errors');
const { authenticateJWT, requireRole, requireModule } = require('../middleware/auth');
const { evaluateEvent } = require('../services/automation');

const VALID_CHECK_TYPES = [
  'LIGHTING', 'FAN', 'AC', 'SWITCH_BOARD', 'SOCKET',
  'WIRING', 'MCB_PANEL', 'EARTHING', 'EMERGENCY_LIGHT'
];
const VALID_ITEM_STATUSES = ['OK', 'FAULTY', 'NA'];
const VALID_YES_NO_STATUSES = ['YES', 'NO', 'NA'];

const INSPECTION_INCLUDE = {
  location: { select: { id: true, name: true, type: true } },
  supervisor: { select: { id: true, name: true } },
  workers: { select: { id: true, name: true } },
  images: { select: { id: true, imageUrl: true, createdAt: true } },
  items: { select: { id: true, checkType: true, status: true, remarks: true, reading: true, templateItemId: true } },
  template: { select: { id: true, name: true, version: true } }
};

async function electricalRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireModule('ele'));

  // Default shift windows (shared config)
  const DEFAULT_SHIFTS = {
    MORNING:   { startHour: 6, startMin: 0, endHour: 14, endMin: 0 },
    AFTERNOON: { startHour: 14, startMin: 0, endHour: 22, endMin: 0 },
    NIGHT:     { startHour: 22, startMin: 0, endHour: 6, endMin: 0 },
    GENERAL:   { startHour: 0, startMin: 0, endHour: 0, endMin: 0 }
  };

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
        if (nowMins >= start && nowMins < end) return shift;
      } else if (end < start) {
        if (nowMins >= start || nowMins < end) return shift;
      }
    }
    return 'GENERAL';
  }

  function isWithinShiftWindowConfig(shift, configs) {
    if (shift === 'GENERAL') return true;
    return shift === getExpectedShiftFromConfig(configs);
  }

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
      return nowMins >= startMins || nowMins < endMins;
    }
  }

  // ── Submit electrical inspection (Supervisor) — multipart form ──
  fastify.post('/electrical-inspections', {
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
    const itemsRaw = fieldValue(request.body.items);
    const templateId = fieldValue(request.body.templateId);

    if (!locationId) return reply.code(400).send({ error: 'locationId is required' });

    // Validate location
    const location = await prisma.location.findFirst({
      where: { id: locationId, orgId, isActive: true }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found or inactive' });

    // Parse worker IDs
    let workerIdList = [];
    try {
      workerIdList = typeof workerIdsRaw === 'string' ? JSON.parse(workerIdsRaw) : (workerIdsRaw || []);
    } catch { /* parse failed */ }

    if (!Array.isArray(workerIdList) || workerIdList.length === 0) {
      return reply.code(400).send({ error: 'At least one worker must be selected' });
    }

    const workers = await prisma.worker.findMany({
      where: { id: { in: workerIdList }, orgId, isActive: true }
    });
    if (workers.length !== workerIdList.length) {
      return reply.code(400).send({ error: 'One or more workers not found or inactive' });
    }

    // Parse checklist items
    let items = [];
    try {
      items = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : (itemsRaw || []);
    } catch { /* parse failed */ }

    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'At least one checklist item is required' });
    }

    // Validate each checklist item — template-aware or legacy
    let templateItemMap = null; // Map<checkKey, templateItem>
    if (templateId) {
      const template = await prisma.inspectionTemplate.findFirst({
        where: { id: templateId, orgId, isActive: true },
        include: { items: true }
      });
      if (!template) return reply.code(400).send({ error: 'Template not found or inactive' });
      templateItemMap = new Map(template.items.map(ti => [ti.checkKey, ti]));

      // Ensure all required template items are present
      const requiredKeys = template.items.filter(ti => ti.isRequired).map(ti => ti.checkKey);
      const submittedKeys = items.map(i => i.checkType);
      const missing = requiredKeys.filter(k => !submittedKeys.includes(k));
      if (missing.length > 0) {
        return reply.code(400).send({ error: 'Missing required items: ' + missing.join(', ') });
      }

      for (const item of items) {
        const ti = templateItemMap.get(item.checkType);
        if (!ti) {
          return reply.code(400).send({ error: 'Item ' + item.checkType + ' not in template' });
        }
        // Validate based on responseType
        if (ti.responseType === 'STATUS') {
          if (!VALID_ITEM_STATUSES.includes(item.status)) {
            return reply.code(400).send({ error: 'Invalid status for ' + item.checkType + ': ' + item.status });
          }
        } else if (ti.responseType === 'YES_NO') {
          if (!VALID_YES_NO_STATUSES.includes(item.status)) {
            return reply.code(400).send({ error: 'Invalid yes/no response for ' + item.checkType + ': ' + item.status });
          }
        } else if (ti.responseType === 'READING') {
          if (item.reading == null || typeof item.reading !== 'number') {
            return reply.code(400).send({ error: 'Numeric reading required for ' + item.checkType });
          }
          // Auto-determine status from reading bounds
          if (ti.minValue != null && item.reading < ti.minValue) item.status = 'FAULTY';
          else if (ti.maxValue != null && item.reading > ti.maxValue) item.status = 'FAULTY';
          else if (!item.status) item.status = 'OK';
        }
        if (item.remarks && typeof item.remarks === 'string' && item.remarks.length > 500) {
          return reply.code(400).send({ error: 'Remarks too long for ' + item.checkType });
        }
      }
    } else {
      // Legacy validation — hardcoded check types
      for (const item of items) {
        if (!VALID_CHECK_TYPES.includes(item.checkType)) {
          return reply.code(400).send({ error: 'Invalid check type: ' + item.checkType });
        }
        if (!VALID_ITEM_STATUSES.includes(item.status)) {
          return reply.code(400).send({ error: 'Invalid status for ' + item.checkType + ': ' + item.status });
        }
        if (item.remarks && typeof item.remarks === 'string' && item.remarks.length > 500) {
          return reply.code(400).send({ error: 'Remarks too long for ' + item.checkType });
        }
      }
    }

    // Validate shift
    const validShifts = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'];
    if (!validShifts.includes(shift)) {
      return reply.code(400).send({ error: 'Invalid shift value' });
    }

    const shiftConfigs = await getShiftConfigs(orgId);
    if (!hasShiftStarted(shift, shiftConfigs)) {
      return reply.code(400).send({
        error: 'Cannot submit inspection for ' + shift + ' shift — it has not started yet.',
        code: 'FUTURE_SHIFT'
      });
    }

    // Handle image upload(s) — optional for inspections (photos of faults)
    const imageField = request.body.image;
    const uploadedUrls = [];
    let uploadFailures = 0;

    if (imageField) {
      const files = Array.isArray(imageField) ? imageField : [imageField];
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
          fastify.log.error({ err: uploadErr, orgId, locationId }, 'R2 image upload failed');
        }
      }
    }

    // Shift mismatch detection
    const expectedShift = getExpectedShiftFromConfig(shiftConfigs);
    const isLate = !isWithinShiftWindowConfig(shift, shiftConfigs);

    if (isLate && (!lateReason || !lateReason.trim())) {
      return reply.code(400).send({
        error: 'You are submitting for ' + shift + ' shift outside the allowed time window. Please provide a reason.',
        code: 'SHIFT_MISMATCH',
        expectedShift
      });
    }

    const faultyCount = items.filter(i => i.status === 'FAULTY' || i.status === 'NO').length;

    const record = await prisma.electricalInspection.create({
      data: {
        orgId,
        locationId,
        supervisorId: request.user.id,
        templateId: templateId || null,
        shift,
        expectedShift: isLate ? expectedShift : null,
        isLate,
        lateReason: isLate ? (lateReason || '').trim() : null,
        notes: notes || null,
        faultyCount,
        workers: { connect: workerIdList.map(id => ({ id })) },
        images: uploadedUrls.length > 0
          ? { create: uploadedUrls.map(url => ({ imageUrl: url })) }
          : undefined,
        items: {
          create: items.map(i => ({
            checkType: i.checkType,
            status: i.status,
            remarks: i.status === 'FAULTY' ? (i.remarks || '').trim() || null : null,
            reading: i.reading != null ? i.reading : null,
            templateItemId: templateItemMap ? (templateItemMap.get(i.checkType)?.id || null) : null
          }))
        }
      },
      include: INSPECTION_INCLUDE
    });

    // Fire-and-forget: alert evaluation
    if (faultyCount > 0) {
      evaluateEvent('INSPECTION_FAULT', orgId, {
        entityType: 'inspection', entityId: record.id,
        faultyCount, shift, locationId, locationName: record.location?.name,
        supervisorName: record.supervisor?.name, module: 'ele'
      }, fastify.log).catch(() => {});
    }
    if (isLate) {
      evaluateEvent('INSPECTION_LATE', orgId, {
        entityType: 'inspection', entityId: record.id,
        shift, locationId, locationName: record.location?.name,
        lateReason: lateReason || '', module: 'ele'
      }, fastify.log).catch(() => {});
    }

    if (uploadFailures > 0) {
      return { ...record, _warning: `${uploadFailures} image(s) failed to upload.` };
    }

    return record;
  });

  // ── List electrical inspections ──
  fastify.get('/electrical-inspections', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { locationId, workerId, supervisorId, shift, from, to, status, page, limit, search, isLate, hasFaults, sort } = request.query;

    const where = { orgId };
    if (locationId) where.locationId = locationId;
    if (shift) where.shift = shift;
    if (status) where.status = status;
    if (workerId) where.workers = { some: { id: workerId } };
    if (isLate === 'true') where.isLate = true;
    if (isLate === 'false') where.isLate = false;
    if (hasFaults === 'true') where.faultyCount = { gt: 0 };
    if (hasFaults === 'false') where.faultyCount = 0;

    if (search && search.trim()) {
      where.location = { name: { contains: search.trim(), mode: 'insensitive' } };
    }

    if (request.user.role === 'SUPERVISOR') {
      where.supervisorId = request.user.id;
    } else if (supervisorId) {
      where.supervisorId = supervisorId;
    }

    if (from || to) {
      where.inspectedAt = {};
      if (from) where.inspectedAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) { toDate.setHours(23, 59, 59, 999); }
        where.inspectedAt.lte = toDate;
      }
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    let orderBy = [{ inspectedAt: 'desc' }];
    if (sort === 'oldest') orderBy = [{ inspectedAt: 'asc' }];
    if (sort === 'location') orderBy = [{ location: { name: 'asc' } }, { inspectedAt: 'desc' }];
    if (sort === 'faults') orderBy = [{ faultyCount: 'desc' }, { inspectedAt: 'desc' }];

    const [records, total, flaggedCount, lateCount, faultyTotal] = await Promise.all([
      prisma.electricalInspection.findMany({ where, orderBy, take, skip, include: INSPECTION_INCLUDE }),
      prisma.electricalInspection.count({ where }),
      prisma.electricalInspection.count({ where: { ...where, status: 'FLAGGED' } }),
      prisma.electricalInspection.count({ where: { ...where, isLate: true } }),
      prisma.electricalInspection.count({ where: { ...where, faultyCount: { gt: 0 } } })
    ]);

    return {
      records,
      total,
      pages: Math.ceil(total / take),
      stats: { flagged: flaggedCount, late: lateCount, faults: faultyTotal, total }
    };
  });

  // ── Get single inspection ──
  fastify.get('/electrical-inspections/:id', {
    preHandler: [requireRole('ADMIN', 'SUPERVISOR')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const record = await prisma.electricalInspection.findFirst({
      where: { id: request.params.id, orgId },
      include: INSPECTION_INCLUDE
    });
    if (!record) return reply.code(404).send({ error: 'Inspection not found' });
    if (request.user.role === 'SUPERVISOR' && record.supervisorId !== request.user.id) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    return record;
  });

  // ── Flag / unflag inspection (Admin only) ──
  fastify.patch('/electrical-inspections/:id/flag', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const record = await prisma.electricalInspection.findFirst({
      where: { id: request.params.id, orgId },
      select: { id: true, status: true }
    });
    if (!record) return reply.code(404).send({ error: 'Inspection not found' });

    const reason = (request.body.reason || '').trim().substring(0, 500) || null;
    const newStatus = record.status === 'FLAGGED' ? 'SUBMITTED' : 'FLAGGED';

    const updated = await prisma.electricalInspection.update({
      where: { id: record.id },
      data: {
        status: newStatus,
        flagReason: newStatus === 'FLAGGED' ? reason : null
      },
      include: INSPECTION_INCLUDE
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: newStatus === 'FLAGGED' ? 'electrical_inspection_flagged' : 'electrical_inspection_unflagged',
        entityType: 'ElectricalInspection',
        entityId: record.id,
        newValue: { reason }
      }
    });

    return updated;
  });

  // ── Export CSV (Admin only) ──
  fastify.get('/electrical-inspections/export', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { locationId, shift, from, to, status, isLate } = request.query;

    const where = { orgId };
    if (locationId) where.locationId = locationId;
    if (shift) where.shift = shift;
    if (status) where.status = status;
    if (isLate === 'true') where.isLate = true;
    if (isLate === 'false') where.isLate = false;
    if (from || to) {
      where.inspectedAt = {};
      if (from) where.inspectedAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.inspectedAt.lte = toDate;
      }
    }

    const records = await prisma.electricalInspection.findMany({
      where,
      orderBy: { inspectedAt: 'desc' },
      take: 5000,
      include: {
        location: { select: { name: true, type: true } },
        supervisor: { select: { name: true } },
        workers: { select: { name: true } },
        template: { select: { name: true } },
        items: { select: { checkType: true, status: true, remarks: true, reading: true } }
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

    const header = 'Date,Time,Location,Type,Shift,Template,Supervisor,Workers,Faults,Status,Late,Late Reason,Check Items,Notes';
    const rows = records.map(r => {
      const d = new Date(r.inspectedAt);
      const date = d.toLocaleDateString('en-IN');
      const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const workerNames = r.workers.map(w => w.name).join('; ');
      const itemsSummary = r.items.map(i => {
        let entry = i.checkType + ':' + i.status;
        if (i.reading != null) entry += '[' + i.reading + ']';
        if (i.remarks) entry += '(' + i.remarks + ')';
        return entry;
      }).join('; ');
      return [
        csvGuard(date), csvGuard(time), csvGuard(r.location?.name), csvGuard(r.location?.type),
        csvGuard(r.shift), csvGuard(r.template?.name || 'Legacy'),
        csvGuard(r.supervisor?.name), csvGuard(workerNames),
        r.faultyCount, csvGuard(r.status), r.isLate ? 'Yes' : 'No',
        csvGuard(r.lateReason), csvGuard(itemsSummary), csvGuard(r.notes)
      ].join(',');
    });

    const csv = header + '\n' + rows.join('\n');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="electrical-inspections-' + new Date().toISOString().split('T')[0] + '.csv"');
    return csv;
  });
}

module.exports = electricalRoutes;
