// Load env + validate before anything else
const { APP_URL } = require('./src/config/env');

// Lib modules
const { prisma, connectWithRetry } = require('./src/lib/prisma');
const { setLogger: setR2Logger } = require('./src/lib/r2');
const { buildInfo, configStatus } = require('./src/lib/diagnostics');

// Plugins
const { registerSecurityPlugins } = require('./src/plugins/security');
const { registerContentPlugins } = require('./src/plugins/content');
const { registerObservability } = require('./src/plugins/observability');

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
const complaintCategoryRoutes = require('./src/routes/complaint-categories');
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
const { ensureModuleRegistry } = require('./src/services/module-registry');

// Security: audit SuperAdmin org-context switches
const { registerSAuditHook } = require('./src/middleware/auth');

// Error handling & logging
const { logError, registerErrorHandlers } = require('./src/errors');
const { buildLoggerOptions } = require('./src/lib/log-redaction');

/**
 * Construct a fresh Fastify instance (no plugins/routes registered yet, not listening).
 * Kept separate from registerApp() so tests can build+register without connecting to
 * the database or binding a port.
 */
function resolveLoggerOptions(logger) {
  // Every logger this app builds gets the redacting serializers (src/lib/log-redaction.js),
  // including a caller-supplied options object; `false` (no logging) stays false. [WP-A]
  if (logger === false) return false;
  if (logger && typeof logger === 'object') return buildLoggerOptions(logger);
  return buildLoggerOptions({
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: { colorize: true }
    } : undefined
  });
}

function buildApp(opts = {}) {
  const fastify = require('fastify')({
    trustProxy: true,
    ignoreTrailingSlash: true,
    requestTimeout: 30000, // 30s max per request
    genReqId: () => `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    logger: resolveLoggerOptions(opts.logger)
  });

  setR2Logger(fastify.log);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
    fastify.log.info('Server shutting down, database disconnected');
  });

  return fastify;
}

/**
 * Register all plugins, error handlers, and routes onto a Fastify instance built by
 * buildApp(). Does not connect to the database, seed the module registry, or listen —
 * callers (start(), or a test harness) are responsible for that.
 */
async function registerApp(fastify) {
  await registerSecurityPlugins(fastify);
  await registerContentPlugins(fastify);
  registerObservability(fastify);
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
    api.register(complaintCategoryRoutes);
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

  return fastify;
}

//==================== STARTUP ====================
async function start() {
  const fastify = buildApp();
  let cleanupTimers, automationTimers;

  // Startup and shutdown lifecycle events are logged at 'warn' rather than 'info'
  // deliberately: the logger's level is 'warn' in production (to avoid per-request
  // info-level noise at scale), which meant every one of these messages — including
  // the pre-existing "server listening" line — was previously silently discarded in
  // production and never actually visible for diagnosing a startup problem.
  try {
    fastify.log.warn('[startup] Connecting to database...');
    await connectWithRetry(fastify.log);

    fastify.log.warn('[startup] Ensuring module registry...');
    await ensureModuleRegistry(prisma, fastify.log);

    fastify.log.warn('[startup] Registering plugins and routes...');
    await registerApp(fastify);

    fastify.log.warn('[startup] Starting HTTP listener...');
    await fastify.listen({
      port: parseInt(process.env.PORT) || 3000,
      host: '0.0.0.0'
    });

    // Start image cleanup scheduler (30-day retention). Its timer handles are
    // captured here — previously they were returned but discarded — so
    // graceful shutdown below can actually clear them.
    cleanupTimers = startCleanupScheduler(fastify.log);

    // Start automation scheduler (alerts + AI insights). Same reasoning.
    automationTimers = startAutomationScheduler(fastify.log);

    fastify.log.warn(`[startup] Ready — server listening at ${APP_URL}`);
    // Startup diagnostics: one concise summary of what's running and how it's configured,
    // logged at 'warn' so it's visible in production (which suppresses info-level logs).
    // Same data /health/info serves — one source of truth (src/lib/diagnostics.js). [M6]
    fastify.log.warn({ build: buildInfo(), configuration: configStatus() }, '[startup] runtime configuration');
  } catch (err) {
    fastify.log.error({ err }, '[startup] Failed to start server');
    process.exit(1);
  }

  process.on('unhandledRejection', (reason, promise) => {
    fastify.log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logError(reason instanceof Error ? reason : new Error(String(reason)));
  });

  // A synchronous exception that escapes every try/catch and Fastify's own
  // request-lifecycle error handling had no handler at all — Node's default
  // behavior (print to stderr, exit) would have skipped this app's own error
  // log and alerting entirely. Per Node's own guidance, resuming after an
  // uncaughtException is unsafe (the process may be in an undefined state) —
  // this logs consistently with unhandledRejection above, then exits, rather
  // than attempting to keep serving traffic. [WP12]
  process.on('uncaughtException', (err) => {
    fastify.log.error({ err }, '[fatal] Uncaught exception — process will exit');
    logError(err).finally(() => process.exit(1));
  });

  //==================== GRACEFUL SHUTDOWN ====================
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, async () => {
      fastify.log.warn(`[shutdown] Received ${signal}, starting graceful shutdown...`);
      try {
        // Stop scheduling new background-job ticks before closing the server, so a
        // scheduler doesn't fire mid-shutdown. Previously these timer handles were
        // returned by start*Scheduler() but never captured or cleared here.
        for (const timer of Object.values(cleanupTimers || {})) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        for (const timer of Object.values(automationTimers || {})) {
          clearTimeout(timer);
          clearInterval(timer);
        }

        await fastify.close();
        fastify.log.warn('[shutdown] Server closed gracefully');
        process.exit(0);
      } catch (err) {
        fastify.log.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
  });
}

// Only boot the real server when this file is run directly (`node index.js`),
// not when it's require()'d by a test harness.
if (require.main === module) {
  start();
}

module.exports = { buildApp, registerApp };
