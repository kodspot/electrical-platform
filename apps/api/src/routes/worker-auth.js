'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST } = require('../lib/security');
const { loginRateLimit } = require('../middleware/rateLimits');

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
}

module.exports = workerAuthRoutes;
module.exports.authenticateWorkerJWT = authenticateWorkerJWT;
