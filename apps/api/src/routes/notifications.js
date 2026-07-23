'use strict';

const { prisma } = require('../lib/prisma');
const { authenticateJWT, requirePolicy } = require('../middleware/auth');
const { addConnection, removeConnection } = require('../services/sse');
const {
  createNotification,
  notifyAdmins,
  notifySupervisors,
  notifyWorkers
} = require('../services/notification-service');

async function notificationRoutes(fastify) {

  // ── SSE stream endpoint (authenticated users: admin/supervisor) ──
  fastify.get('/notifications/stream', {
    preHandler: [authenticateJWT, requirePolicy('ORG_STAFF')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const userId = request.user.id;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable Nginx/Caddy buffering
    });

    // Send initial connection confirmation
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    addConnection(orgId, 'user', userId, reply);

    // Heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    // Cleanup on close
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      removeConnection(orgId, 'user', userId, reply);
    });

    // Don't end the response — keep it open for SSE
    return reply;
  });

  // ── Worker SSE stream endpoint ──
  fastify.get('/notifications/worker-stream', async (request, reply) => {
    // Worker auth via query param token (since workers use JWT too)
    const jwt = require('jsonwebtoken');
    const token = request.query.token;
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (!decoded.workerId) return reply.code(401).send({ error: 'Unauthorized' });

    const worker = await prisma.worker.findUnique({
      where: { id: decoded.workerId },
      select: { id: true, orgId: true, isActive: true, tokenInvalidBefore: true }
    });
    if (!worker || !worker.isActive) return reply.code(401).send({ error: 'Unauthorized' });
    if (worker.tokenInvalidBefore && decoded.iat && decoded.iat < Math.floor(worker.tokenInvalidBefore.getTime() / 1000)) {
      return reply.code(401).send({ error: 'Session expired' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ workerId: worker.id })}\n\n`);

    addConnection(worker.orgId, 'worker', worker.id, reply);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      removeConnection(worker.orgId, 'worker', worker.id, reply);
    });

    return reply;
  });

  // ── Authenticated routes for users ──
  fastify.register(async function userNotificationRoutes(sub) {
    sub.addHook('preHandler', authenticateJWT);
    sub.addHook('preHandler', requirePolicy('ORG_STAFF'));

    // ── Unread count (lightweight poll/fallback endpoint) ──
    sub.get('/notifications/unread-count', async (request) => {
      const count = await prisma.notification.count({
        where: { userId: request.user.id, isRead: false }
      });
      return { count };
    });

    // ── List notifications (paginated, newest first) ──
    sub.get('/notifications', async (request) => {
      const limit = Math.min(parseInt(request.query.limit) || 20, 50);
      const offset = parseInt(request.query.offset) || 0;

      const [notifications, total, unread] = await Promise.all([
        prisma.notification.findMany({
          where: { userId: request.user.id },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset
        }),
        prisma.notification.count({ where: { userId: request.user.id } }),
        prisma.notification.count({ where: { userId: request.user.id, isRead: false } })
      ]);

      return { notifications, total, unread };
    });

    // ── Mark all as read ──
    sub.patch('/notifications/read-all', async (request) => {
      await prisma.notification.updateMany({
        where: { userId: request.user.id, isRead: false },
        data: { isRead: true }
      });
      return { success: true };
    });

    // ── Clear all read notifications ──
    sub.delete('/notifications/clear-read', async (request) => {
      const result = await prisma.notification.deleteMany({
        where: { userId: request.user.id, isRead: true }
      });
      return { success: true, deleted: result.count };
    });

    // ── Mark single notification as read ──
    sub.patch('/notifications/:id/read', async (request, reply) => {
      const { id } = request.params;
      const notif = await prisma.notification.findFirst({
        where: { id, userId: request.user.id }
      });
      if (!notif) return reply.code(404).send({ error: 'Not found' });

      await prisma.notification.update({
        where: { id },
        data: { isRead: true }
      });
      return { success: true };
    });

    // ── Delete single notification ──
    sub.delete('/notifications/:id', async (request, reply) => {
      const { id } = request.params;
      const notif = await prisma.notification.findFirst({
        where: { id, userId: request.user.id }
      });
      if (!notif) return reply.code(404).send({ error: 'Not found' });

      await prisma.notification.delete({ where: { id } });
      return { success: true };
    });
  });
}

module.exports = notificationRoutes;
module.exports.createNotification = createNotification;
module.exports.notifyAdmins = notifyAdmins;
module.exports.notifySupervisors = notifySupervisors;
module.exports.notifyWorkers = notifyWorkers;
