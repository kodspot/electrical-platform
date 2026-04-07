'use strict';

const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST, passwordSchema } = require('../lib/security');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { encryptWorkerPII, decryptWorkerPII, encryptField, decryptField } = require('../lib/crypto');
const { APP_URL } = require('../config/env');

async function superadminRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('SUPER_ADMIN'));

  // === Organizations ===

  fastify.get('/superadmin/organizations', async (request) => {
    const { status, search } = request.query;
    const where = {};
    if (status) where.status = status;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    return prisma.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, slug: true, type: true, address: true, phone: true, email: true,
        logoUrl: true, status: true, enabledModules: true, aiEnabled: true, aiProvider: true, aiModel: true,
        createdAt: true, updatedAt: true,
        _count: { select: { users: true, workers: true, locations: true } }
      }
    });
  });

  fastify.post('/superadmin/organizations', async (request, reply) => {
    const VALID_MODULES = ['ele', 'civil', 'asset', 'complaints'];
    const schema = z.object({
      name: z.string().min(1).max(200).trim(),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens only').optional(),
      type: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      enabledModules: z.array(z.enum(VALID_MODULES)).min(1).optional()
    });

    const data = schema.parse(request.body);
    if (!data.enabledModules) data.enabledModules = ['ele'];

    // Use provided slug or auto-generate from name
    let slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
    if (!slug) slug = 'org-' + Date.now().toString(36).slice(-6);
    // Ensure uniqueness
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (existing) return reply.code(409).send({ error: 'Slug "' + slug + '" is already taken. Choose a different one.' });
    data.slug = slug;

    const org = await prisma.organization.create({ data });

    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_created',
        entityType: 'Organization',
        entityId: org.id,
        newValue: data
      }
    });

    return org;
  });

  fastify.patch('/superadmin/organizations/:id', async (request, reply) => {
    const { id } = request.params;
    const VALID_MODULES = ['ele', 'civil', 'asset', 'complaints'];
    const schema = z.object({
      name: z.string().min(1).max(200).trim().optional(),
      slug: z.string().min(1).max(50).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens (no leading/trailing hyphens)').optional(),
      type: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional().or(z.literal('')),
      status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      enabledModules: z.array(z.enum(VALID_MODULES)).min(1).optional()
    });

    const data = schema.parse(request.body);
    if (data.email === '') data.email = null;

    const existing = await prisma.organization.findUnique({ where: { id } });
    if (!existing || existing.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    // If slug is being changed, check uniqueness
    if (data.slug && data.slug !== existing.slug) {
      const slugTaken = await prisma.organization.findUnique({ where: { slug: data.slug } });
      if (slugTaken) return reply.code(409).send({ error: 'Slug "' + data.slug + '" is already taken.' });
    }

    const updated = await prisma.organization.update({ where: { id }, data });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_updated',
        entityType: 'Organization',
        entityId: id,
        oldValue: { name: existing.name, status: existing.status },
        newValue: data
      }
    });

    return updated;
  });

  fastify.delete('/superadmin/organizations/:id', async (request, reply) => {
    const { id } = request.params;

    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org || org.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    await prisma.organization.update({
      where: { id },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        purgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'organization_deleted',
        entityType: 'Organization',
        entityId: id
      }
    });

    return { success: true, message: 'Organization soft-deleted' };
  });

  // === Admin Users ===

  fastify.post('/superadmin/organizations/:orgId/admins', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      phone: z.string().max(20).optional(),
      password: passwordSchema
    });

    const data = schema.parse(request.body);
    const normalizedEmail = data.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { orgId_email: { orgId, email: normalizedEmail } }
    });
    if (existing) {
      return reply.code(409).send({ error: 'A user with this email already exists in this organization' });
    }

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

    const admin = await prisma.user.create({
      data: {
        orgId,
        name: data.name,
        email: normalizedEmail,
        phone: data.phone || null,
        passwordHash,
        role: 'ADMIN'
      },
      select: { id: true, name: true, email: true, phone: true, role: true, orgId: true, createdAt: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'admin_created',
        entityType: 'User',
        entityId: admin.id,
        newValue: { name: admin.name, email: admin.email }
      }
    });

    return admin;
  });

  fastify.get('/superadmin/users', async (request) => {
    const { orgId, role } = request.query;
    const where = {};
    if (orgId) where.orgId = orgId;
    if (role) where.role = role;

    return prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        orgId: true, isActive: true, createdAt: true,
        org: { select: { id: true, name: true } }
      }
    });
  });

  fastify.patch('/superadmin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      isActive: z.boolean().optional(),
      orgId: z.string().uuid().optional()
    });

    const data = schema.parse(request.body);
    if (data.email) data.email = data.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    // If changing org, validate the target org exists and is active
    const targetOrgId = data.orgId || user.orgId;
    if (data.orgId && data.orgId !== user.orgId) {
      const targetOrg = await prisma.organization.findUnique({ where: { id: data.orgId } });
      if (!targetOrg || targetOrg.status !== 'ACTIVE') {
        return reply.code(400).send({ error: 'Target organization not found or not active' });
      }
    }

    // If changing email or org, check uniqueness within the target org
    const emailToCheck = data.email || user.email;
    const emailChanged = data.email && data.email !== user.email;
    const orgChanged = data.orgId && data.orgId !== user.orgId;
    if ((emailChanged || orgChanged) && targetOrgId) {
      const dup = await prisma.user.findUnique({
        where: { orgId_email: { orgId: targetOrgId, email: emailToCheck } }
      });
      if (dup && dup.id !== id) return reply.code(409).send({ error: 'Email already in use in the target organization' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, orgId: true }
    });

    const oldValue = { name: user.name, email: user.email };
    if (orgChanged) oldValue.orgId = user.orgId;

    await prisma.auditLog.create({
      data: {
        orgId: targetOrgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: orgChanged ? 'user_transferred' : 'user_updated',
        entityType: 'User',
        entityId: id,
        oldValue,
        newValue: data
      }
    });

    return updated;
  });

  fastify.patch('/superadmin/users/:id/password', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      password: passwordSchema
    });

    const { password } = schema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await prisma.user.update({ where: { id }, data: { passwordHash, tokenInvalidBefore: new Date() } });

    await prisma.auditLog.create({
      data: {
        orgId: user.orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'password_reset',
        entityType: 'User',
        entityId: id
      }
    });

    return { success: true, message: 'Password updated' };
  });

  // === Supervisor Management (SuperAdmin can create/manage supervisors for any org) ===

  fastify.post('/superadmin/organizations/:orgId/supervisors', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      name: z.string().min(1).max(100).trim(),
      email: z.string().email().max(200),
      phone: z.string().max(20).optional(),
      password: passwordSchema
    });

    const data = schema.parse(request.body);
    const normalizedEmail = data.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { orgId_email: { orgId, email: normalizedEmail } }
    });
    if (existing) return reply.code(409).send({ error: 'A user with this email already exists in this organization' });

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

    const supervisor = await prisma.user.create({
      data: { orgId, name: data.name, email: normalizedEmail, phone: data.phone || null, passwordHash, role: 'SUPERVISOR' },
      select: { id: true, name: true, email: true, phone: true, role: true, orgId: true, createdAt: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'supervisor_created',
        entityType: 'User',
        entityId: supervisor.id,
        newValue: { name: supervisor.name, email: supervisor.email }
      }
    });

    return supervisor;
  });

  // === Worker Management (SuperAdmin can manage workers for any org) ===

  fastify.get('/superadmin/organizations/:orgId/workers', async (request, reply) => {
    const { orgId } = request.params;
    return prisma.worker.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: {
        id: true, employeeId: true, name: true, phone: true, email: true,
        department: true, designation: true, gender: true, dateOfJoin: true,
        isActive: true, createdAt: true,
        _count: { select: { electricalInspections: true } }
      }
    });
  });

  fastify.post('/superadmin/organizations/:orgId/workers', async (request, reply) => {
    const { orgId } = request.params;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org || org.status !== 'ACTIVE') {
      return reply.code(404).send({ error: 'Organization not found or not active' });
    }

    const schema = z.object({
      employeeId: z.string().max(50).optional(),
      name: z.string().min(1).max(100).trim(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional(),
      address: z.string().max(500).optional(),
      department: z.string().max(100).optional(),
      designation: z.string().max(100).optional(),
      dateOfBirth: z.string().optional(),
      dateOfJoin: z.string().optional(),
      gender: z.enum(['Male', 'Female', 'Other']).optional(),
      bloodGroup: z.string().max(10).optional(),
      aadharNo: z.string().max(20).optional(),
      notes: z.string().max(1000).optional()
    });

    const data = schema.parse(request.body);

    // Check duplicate name
    const dupName = await prisma.worker.findFirst({ where: { orgId, name: data.name } });
    if (dupName) return reply.code(409).send({ error: 'A worker with this name already exists in this organization' });

    // Check duplicate employeeId
    if (data.employeeId) {
      const dupId = await prisma.worker.findFirst({ where: { orgId, employeeId: data.employeeId } });
      if (dupId) return reply.code(409).send({ error: 'A worker with this employee ID already exists' });
    }

    const workerData = {
      orgId,
      name: data.name,
      employeeId: data.employeeId || null,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      department: data.department || null,
      designation: data.designation || null,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      dateOfJoin: data.dateOfJoin ? new Date(data.dateOfJoin) : null,
      gender: data.gender || null,
      bloodGroup: data.bloodGroup || null,
      aadharNo: data.aadharNo || null,
      notes: data.notes || null
    };
    encryptWorkerPII(workerData);

    const worker = await prisma.worker.create({ data: workerData });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'worker_created',
        entityType: 'Worker',
        entityId: worker.id,
        newValue: { name: worker.name, employeeId: worker.employeeId }
      }
    });

    return decryptWorkerPII(worker);
  });

  fastify.patch('/superadmin/workers/:id', async (request, reply) => {
    const { id } = request.params;

    const worker = await prisma.worker.findUnique({ where: { id } });
    if (!worker) return reply.code(404).send({ error: 'Worker not found' });

    const schema = z.object({
      employeeId: z.string().max(50).optional(),
      name: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(20).optional(),
      email: z.string().email().max(200).optional().or(z.literal('')),
      address: z.string().max(500).optional(),
      department: z.string().max(100).optional(),
      designation: z.string().max(100).optional(),
      dateOfBirth: z.string().optional().nullable(),
      dateOfJoin: z.string().optional().nullable(),
      gender: z.enum(['Male', 'Female', 'Other']).optional().nullable(),
      bloodGroup: z.string().max(10).optional(),
      aadharNo: z.string().max(20).optional(),
      notes: z.string().max(1000).optional(),
      isActive: z.boolean().optional()
    });

    const data = schema.parse(request.body);

    // Check duplicate name
    if (data.name && data.name !== worker.name) {
      const dup = await prisma.worker.findFirst({ where: { orgId: worker.orgId, name: data.name } });
      if (dup) return reply.code(409).send({ error: 'A worker with this name already exists' });
    }

    // Check duplicate employeeId
    if (data.employeeId && data.employeeId !== worker.employeeId) {
      const dup = await prisma.worker.findFirst({ where: { orgId: worker.orgId, employeeId: data.employeeId } });
      if (dup) return reply.code(409).send({ error: 'A worker with this employee ID already exists' });
    }

    if (data.email === '') data.email = null;
    if (data.dateOfBirth) data.dateOfBirth = new Date(data.dateOfBirth);
    if (data.dateOfJoin) data.dateOfJoin = new Date(data.dateOfJoin);

    encryptWorkerPII(data);

    const updated = await prisma.worker.update({ where: { id }, data });
    return decryptWorkerPII(updated);
  });

  // === System Analytics (cross-org stats for SuperAdmin) ===

  fastify.get('/superadmin/analytics', async (request) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalOrgs,
      activeOrgs,
      totalAdmins,
      totalSupervisors,
      totalWorkers,
      totalLocations,
      totalRecords,
      todayRecords,
      totalImages,
      totalTickets,
      openTickets
    ] = await Promise.all([
      prisma.organization.count({ where: { status: { not: 'DELETED' } } }),
      prisma.organization.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
      prisma.user.count({ where: { role: 'SUPERVISOR', isActive: true } }),
      prisma.worker.count({ where: { isActive: true } }),
      prisma.location.count({ where: { isActive: true } }),
      prisma.electricalInspection.count(),
      prisma.electricalInspection.count({ where: { inspectedAt: { gte: todayStart } } }),
      prisma.electricalImage.count(),
      prisma.ticket.count(),
      prisma.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } })
    ]);

    // Daily inspection activity for last 7 days
    const last7Days = new Date();
    last7Days.setDate(last7Days.getDate() - 7);
    last7Days.setHours(0, 0, 0, 0);

    const dailyTrend = await prisma.$queryRaw`
      SELECT DATE("inspectedAt") as date, COUNT(*)::int as count
      FROM "ElectricalInspection"
      WHERE "inspectedAt" >= ${last7Days}
      GROUP BY DATE("inspectedAt")
      ORDER BY date ASC
    `;

    const recordsLast7Days = (dailyTrend || []).reduce((sum, d) => sum + d.count, 0);

    return {
      totalOrgs, activeOrgs, totalAdmins, totalSupervisors, totalWorkers, totalLocations,
      totalRecords, todayRecords, totalImages, totalTickets, openTickets,
      totalQrScans: totalRecords,
      recordsLast7Days,
      avgImagesPerRecord: totalRecords > 0 ? (totalImages / totalRecords).toFixed(1) : '0',
      dailyTrend: (dailyTrend || []).map(d => ({ date: d.date, count: d.count }))
    };
  });

  // Per-org breakdown
  fastify.get('/superadmin/analytics/orgs', async (request) => {
    const orgs = await prisma.organization.findMany({
      where: { status: { not: 'DELETED' } },
      select: {
        id: true, name: true, status: true,
        _count: {
          select: { users: true, workers: true, locations: true, electricalInspections: true, tickets: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Get image counts per org
    const imageCounts = await prisma.$queryRaw`
      SELECT ei."orgId", COUNT(img.id)::int as "imageCount"
      FROM "ElectricalImage" img
      JOIN "ElectricalInspection" ei ON img."inspectionId" = ei.id
      GROUP BY ei."orgId"
    `;
    const imageMap = new Map((imageCounts || []).map(r => [r.orgId, r.imageCount]));

    return orgs.map(o => ({
      ...o,
      imageCount: imageMap.get(o.id) || 0
    }));
  });

  // Per-org worker performance (SuperAdmin can view worker analytics for any org)
  fastify.get('/superadmin/analytics/orgs/:orgId/workers', async (request) => {
    const { orgId } = request.params;

    const workers = await prisma.worker.findMany({
      where: { orgId },
      select: {
        id: true, employeeId: true, name: true, isActive: true,
        electricalInspections: {
          select: { inspectedAt: true, _count: { select: { images: true } } },
          orderBy: { inspectedAt: 'desc' }
        }
      },
      orderBy: { name: 'asc' }
    });

    return workers.map(w => ({
      id: w.id,
      employeeId: w.employeeId,
      name: w.name,
      isActive: w.isActive,
      totalRecords: w.electricalInspections.length,
      totalImages: w.electricalInspections.reduce((s, r) => s + r._count.images, 0),
      lastInspectedAt: w.electricalInspections[0]?.inspectedAt || null
    }));
  });

  // === Audit Logs ===
  fastify.get('/superadmin/audit-logs', async (request) => {
    const { orgId, action, actorId, limit, offset } = request.query;
    const where = {};
    if (orgId) where.orgId = orgId;
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (actorId) where.actorId = actorId;

    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = parseInt(offset) || 0;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          org: { select: { name: true } }
        }
      }),
      prisma.auditLog.count({ where })
    ]);

    // Resolve actor names
    const actorIds = [...new Set(logs.filter(l => l.actorId).map(l => l.actorId))];
    const actors = actorIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true, role: true } })
      : [];
    const actorMap = new Map(actors.map(a => [a.id, a]));

    return {
      logs: logs.map(l => ({
        ...l,
        actorName: l.actorId ? (actorMap.get(l.actorId)?.name || 'Unknown') : l.actorType,
        actorRole: l.actorId ? (actorMap.get(l.actorId)?.role || null) : null,
        orgName: l.org?.name || null
      })),
      total,
      limit: take,
      offset: skip
    };
  });

  // === Login QR Code Generator (for superadmin) ===
  const VALID_MODULES_QR = ['ele', 'civil', 'asset', 'complaints'];
  const VALID_ROLES_QR = ['admin', 'supervisor'];

  fastify.get('/superadmin/organizations/:id/login-qr', async (request, reply) => {
    const { id } = request.params;
    const { mod, role } = request.query;

    if (!mod || VALID_MODULES_QR.indexOf(mod) === -1) {
      return reply.code(400).send({ error: 'Invalid module. Must be one of: ' + VALID_MODULES_QR.join(', ') });
    }
    if (!role || VALID_ROLES_QR.indexOf(role) === -1) {
      return reply.code(400).send({ error: 'Invalid role. Must be admin or supervisor' });
    }

    const org = await prisma.organization.findUnique({
      where: { id },
      select: { slug: true, enabledModules: true, status: true }
    });
    if (!org) return reply.code(404).send({ error: 'Organization not found' });
    if (!org.slug) return reply.code(400).send({ error: 'Organization has no slug configured' });

    const enabledMods = org.enabledModules || ['ele'];
    if (enabledMods.indexOf(mod) === -1) {
      return reply.code(400).send({ error: 'Module "' + mod + '" is not enabled for this organization' });
    }

    const loginPage = role === 'admin' ? 'admin-login' : 'supervisor-login';
    const qrData = `${APP_URL}/${org.slug}/${mod}/${loginPage}`;

    const svg = await QRCode.toString(qrData, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#1e293b', light: '#ffffff' }
    });

    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=3600');
    return svg;
  });

  // === AI Assistant Config (per org) ===

  fastify.get('/superadmin/organizations/:id/ai-config', async (request, reply) => {
    const { id } = request.params;
    const org = await prisma.organization.findUnique({
      where: { id },
      select: { aiEnabled: true, aiProvider: true, aiModel: true, aiApiKey: true }
    });
    if (!org) return reply.code(404).send({ error: 'Organization not found' });

    const result = {
      aiEnabled: org.aiEnabled,
      aiProvider: org.aiProvider,
      aiModel: org.aiModel,
      hasApiKey: !!org.aiApiKey
    };

    // Return masked key hints so admin can see which key is configured
    if (org.aiApiKey) {
      try {
        const decrypted = decryptField(org.aiApiKey);
        if (decrypted) {
          if (org.aiProvider === 'azure-openai') {
            const parts = decrypted.split('|');
            if (parts.length === 2) {
              result.azureEndpoint = parts[0];
              result.maskedKey = parts[1].length > 8
                ? parts[1].slice(0, 4) + '••••••••' + parts[1].slice(-4)
                : '••••••••••••';
            }
          } else if (org.aiProvider === 'gemini') {
            result.maskedKey = decrypted.length > 8
              ? decrypted.slice(0, 4) + '••••••••' + decrypted.slice(-4)
              : '••••••••••••';
          }
        }
      } catch { /* ignore decryption errors */ }
    }

    return result;
  });

  fastify.patch('/superadmin/organizations/:id/ai-config', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      aiEnabled: z.boolean().optional(),
      aiProvider: z.enum(['azure-openai', 'gemini']).nullable().optional(),
      aiModel: z.string().max(100).nullable().optional(),
      aiApiKey: z.string().max(4000).nullable().optional()
    });

    const data = schema.parse(request.body);

    const existing = await prisma.organization.findUnique({ where: { id } });
    if (!existing || existing.status === 'DELETED') {
      return reply.code(404).send({ error: 'Organization not found' });
    }

    // Encrypt the API key if provided
    const updateData = {};
    if (data.aiEnabled !== undefined) updateData.aiEnabled = data.aiEnabled;
    if (data.aiProvider !== undefined) updateData.aiProvider = data.aiProvider;
    if (data.aiModel !== undefined) updateData.aiModel = data.aiModel;
    if (data.aiApiKey !== undefined) {
      updateData.aiApiKey = data.aiApiKey ? encryptField(data.aiApiKey) : null;
    }

    const updated = await prisma.organization.update({
      where: { id },
      data: updateData,
      select: { aiEnabled: true, aiProvider: true, aiModel: true, aiApiKey: true }
    });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'ai_config_updated',
        entityType: 'Organization',
        entityId: id,
        newValue: { aiEnabled: updated.aiEnabled, aiProvider: updated.aiProvider, aiModel: updated.aiModel, hasApiKey: !!updated.aiApiKey }
      }
    });

    return {
      aiEnabled: updated.aiEnabled,
      aiProvider: updated.aiProvider,
      aiModel: updated.aiModel,
      hasApiKey: !!updated.aiApiKey
    };
  });

  // === AI Usage Analytics ===

  fastify.get('/superadmin/ai/usage', async (request) => {
    const { days } = request.query;
    const lookback = parseInt(days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - lookback);
    since.setHours(0, 0, 0, 0);

    // Global totals
    const [totalRequests, totalTokens, totalErrors, byProvider, byOrg, dailyTrend] = await Promise.all([
      prisma.aiUsageLog.count({ where: { createdAt: { gte: since } } }),
      prisma.aiUsageLog.aggregate({
        where: { createdAt: { gte: since }, success: true },
        _sum: { totalTokens: true, inputTokens: true, outputTokens: true }
      }),
      prisma.aiUsageLog.count({ where: { createdAt: { gte: since }, success: false } }),
      prisma.aiUsageLog.groupBy({
        by: ['provider'],
        where: { createdAt: { gte: since } },
        _count: true,
        _sum: { totalTokens: true }
      }),
      prisma.$queryRaw`
        SELECT a."orgId", o."name" as "orgName", COUNT(*)::int as requests,
               COALESCE(SUM(a."totalTokens"), 0)::int as tokens,
               COUNT(*) FILTER (WHERE a."success" = false)::int as errors
        FROM "AiUsageLog" a
        JOIN "Organization" o ON a."orgId" = o."id"
        WHERE a."createdAt" >= ${since}
        GROUP BY a."orgId", o."name"
        ORDER BY tokens DESC
        LIMIT 20
      `,
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COUNT(*)::int as requests,
               COALESCE(SUM("totalTokens"), 0)::int as tokens
        FROM "AiUsageLog"
        WHERE "createdAt" >= ${since}
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `
    ]);

    return {
      period: { days: lookback, since },
      totalRequests,
      totalTokens: totalTokens._sum.totalTokens || 0,
      totalInputTokens: totalTokens._sum.inputTokens || 0,
      totalOutputTokens: totalTokens._sum.outputTokens || 0,
      totalErrors,
      errorRate: totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(1) + '%' : '0%',
      byProvider: byProvider.map(p => ({
        provider: p.provider,
        requests: typeof p._count === 'number' ? p._count : p._count?._all || 0,
        tokens: p._sum?.totalTokens || 0
      })),
      byOrg: (byOrg || []).map(o => ({
        orgId: o.orgId,
        orgName: o.orgName,
        requests: o.requests,
        tokens: o.tokens,
        errors: o.errors
      })),
      dailyTrend: (dailyTrend || []).map(d => ({
        date: d.date,
        requests: d.requests,
        tokens: d.tokens
      }))
    };
  });

  // Per-org AI usage detail
  fastify.get('/superadmin/ai/usage/:orgId', async (request) => {
    const { orgId } = request.params;
    const { days, limit, offset } = request.query;
    const lookback = parseInt(days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - lookback);

    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = parseInt(offset) || 0;

    const [org, logs, total, stats] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, aiEnabled: true, aiProvider: true, aiModel: true, aiMonthlyTokenLimit: true, aiTotalTokensUsed: true, aiApiKeyLastUsedAt: true }
      }),
      prisma.aiUsageLog.findMany({
        where: { orgId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take, skip
      }),
      prisma.aiUsageLog.count({ where: { orgId, createdAt: { gte: since } } }),
      prisma.aiUsageLog.aggregate({
        where: { orgId, createdAt: { gte: since }, success: true },
        _sum: { totalTokens: true },
        _avg: { latencyMs: true }
      })
    ]);

    return {
      org: org || {},
      totalRequests: total,
      totalTokens: stats._sum?.totalTokens || 0,
      avgLatencyMs: Math.round(stats._avg?.latencyMs || 0),
      logs,
      limit: take,
      offset: skip
    };
  });

  // Test an API key (sends a minimal prompt to validate it works)
  fastify.post('/superadmin/ai/test-key', async (request, reply) => {
    const schema = z.object({
      provider: z.enum(['azure-openai', 'gemini']),
      model: z.string().max(100).optional(),
      apiKey: z.string().min(1).max(4000)
    });

    const { provider, model, apiKey } = schema.parse(request.body);

    const PROVIDERS = {
      'azure-openai': async (key, mdl) => {
        const parts = key.split('|');
        let endpoint, k;
        if (parts.length === 2) {
          endpoint = parts[0].replace(/\/$/, '') + '/openai/deployments/' + encodeURIComponent(mdl || 'gpt-4o') + '/chat/completions?api-version=2025-01-01-preview';
          k = parts[1];
        } else {
          endpoint = 'https://api.openai.com/v1/chat/completions';
          k = key;
        }
        const isAzure = endpoint.includes('openai.azure.com');
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(isAzure ? { 'api-key': k } : { 'Authorization': `Bearer ${k}` }) },
          body: JSON.stringify({ ...(isAzure ? {} : { model: mdl || 'gpt-4o' }), messages: [{ role: 'user', content: 'Reply with: OK' }], max_tokens: 5 }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`${res.status}: ${err.slice(0, 200)}`); }
        return true;
      },
      'gemini': async (key, mdl) => {
        const modelName = encodeURIComponent(mdl || 'gemini-2.0-flash');
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with: OK' }] }], generationConfig: { maxOutputTokens: 5 } }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) { const err = await res.text().catch(() => ''); throw new Error(`${res.status}: ${err.slice(0, 200)}`); }
        return true;
      }
    };

    const testFn = PROVIDERS[provider];
    if (!testFn) return reply.code(400).send({ error: 'Invalid provider' });

    try {
      await testFn(apiKey, model);
      return { success: true, message: `${provider} key is valid and working.` };
    } catch (err) {
      return { success: false, message: `Key test failed: ${err.message}` };
    }
  });

  // Reset monthly AI token counter for an org
  fastify.post('/superadmin/organizations/:id/ai-reset-usage', async (request, reply) => {
    const { id } = request.params;
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org || org.status === 'DELETED') return reply.code(404).send({ error: 'Organization not found' });

    await prisma.organization.update({
      where: { id },
      data: { aiTotalTokensUsed: 0 }
    });

    await prisma.auditLog.create({
      data: {
        orgId: id,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'ai_usage_reset',
        entityType: 'Organization',
        entityId: id
      }
    });

    return { success: true, message: 'AI token usage reset to 0' };
  });
}

module.exports = superadminRoutes;
