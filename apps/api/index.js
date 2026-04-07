// Load env + validate before anything else
const { APP_URL } = require('./src/config/env');

const fastify = require('fastify')({
  trustProxy: true,
  ignoreTrailingSlash: true,
  requestTimeout: 30000, // 30s max per request
  genReqId: () => `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: { colorize: true }
    } : undefined
  }
});

// Lib modules — wire up loggers
const { prisma, connectWithRetry } = require('./src/lib/prisma');
const { setLogger: setR2Logger } = require('./src/lib/r2');
setR2Logger(fastify.log);

// Plugins
const { registerSecurityPlugins } = require('./src/plugins/security');
const { registerContentPlugins } = require('./src/plugins/content');

// Routes
const healthRoutes = require('./src/routes/health');
const authRoutes = require('./src/routes/auth');
const superadminRoutes = require('./src/routes/superadmin');
const locationRoutes = require('./src/routes/locations');
const workerRoutes = require('./src/routes/workers');
const supervisorRoutes = require('./src/routes/supervisors');
const ticketRoutes = require('./src/routes/tickets');
const analyticsRoutes = require('./src/routes/analytics');
const publicRoutes = require('./src/routes/public');
const imageRoutes = require('./src/routes/images');
const notificationRoutes = require('./src/routes/notifications');
const auditLogRoutes = require('./src/routes/audit-logs');
const attendanceRoutes = require('./src/routes/attendance');
const dutyRosterRoutes = require('./src/routes/duty-roster');
const electricalRoutes = require('./src/routes/electrical');
const templateRoutes = require('./src/routes/templates');
const aiRoutes = require('./src/routes/ai');
const assetRoutes = require('./src/routes/assets');
const assetEventRoutes = require('./src/routes/asset-events');
const assetFailureRoutes = require('./src/routes/asset-failures');
const alertRoutes = require('./src/routes/alerts');
const workerAuthRoutes = require('./src/routes/worker-auth');
const predictionRoutes = require('./src/routes/predictions');
const pageRoutes = require('./src/routes/pages');

// Services
const { startCleanupScheduler } = require('./src/services/cleanup');
const { startAutomationScheduler } = require('./src/services/automation');

// Security: audit SuperAdmin org-context switches
const { registerSAuditHook } = require('./src/middleware/auth');

// Error handling & logging
const { logError, registerErrorHandlers } = require('./src/errors');

//==================== LIFECYCLE ====================
fastify.addHook('onClose', async () => {
  await prisma.$disconnect();
  fastify.log.info('Server shutting down, database disconnected');
});

//==================== STARTUP ====================
async function start() {
  try {
    await connectWithRetry(fastify.log);
    await registerSecurityPlugins(fastify);
    await registerContentPlugins(fastify);
    registerErrorHandlers(fastify);
    registerSAuditHook(fastify);

    // Health check at root (for Docker healthcheck)
    fastify.register(healthRoutes);

    // All API data routes under /api prefix
    fastify.register(async function apiRoutes(api) {
      api.register(healthRoutes);
      api.register(authRoutes);
      api.register(superadminRoutes);
      api.register(locationRoutes);
      api.register(workerRoutes);
      api.register(supervisorRoutes);
      api.register(ticketRoutes);
      api.register(analyticsRoutes);
      api.register(publicRoutes);
      api.register(imageRoutes);
      api.register(notificationRoutes);
      api.register(auditLogRoutes);
      api.register(attendanceRoutes);
      api.register(dutyRosterRoutes);
      api.register(electricalRoutes);
      api.register(templateRoutes);
      api.register(aiRoutes);
      api.register(assetRoutes);
      api.register(assetEventRoutes);
      api.register(assetFailureRoutes);
      api.register(alertRoutes);
      api.register(workerAuthRoutes);
      api.register(predictionRoutes);
    }, { prefix: '/api' });

    // Page-serving routes (org-scoped URLs, short QR, etc.)
    fastify.register(pageRoutes);

    await fastify.listen({
      port: parseInt(process.env.PORT) || 3000,
      host: '0.0.0.0'
    });

    // Start image cleanup scheduler (7-day retention)
    startCleanupScheduler(fastify.log);

    // Start automation scheduler (alerts + AI insights)
    startAutomationScheduler(fastify.log);

    fastify.log.info(`Server listening at ${APP_URL}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  fastify.log.error('Unhandled Rejection at:', promise, 'reason:', reason);
  logError(reason instanceof Error ? reason : new Error(String(reason)));
});

start();

//==================== GRACEFUL SHUTDOWN ====================
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, starting graceful shutdown...`);
    try {
      await fastify.close();
      fastify.log.info('Server closed gracefully');
      process.exit(0);
    } catch (err) {
      fastify.log.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});
