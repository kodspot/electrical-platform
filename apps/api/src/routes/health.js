const { prisma } = require('../lib/prisma');
const { getConnectionStats } = require('../services/sse');
const { dbBreaker, aiBreaker } = require('../lib/circuit-breaker');
const { buildInfo, configStatus } = require('../lib/diagnostics');

async function checkDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'connected';
  } catch (e) {
    return 'disconnected';
  }
}

async function healthRoutes(fastify, opts) {
  // Combined health check — kept exactly as-is for backward compatibility with
  // existing consumers (Docker/Caddy/any external monitoring already pointed at
  // this route). Always responds 200; degraded state is only visible in the body.
  // For a check that reflects readiness via HTTP status code, use /health/ready.
  fastify.get('/health', { config: { rateLimit: false } }, async () => {
    const dbStatus = await checkDatabase();
    const sse = getConnectionStats();
    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      database: dbStatus,
      version: process.env.npm_package_version || '1.0.0',
      sse,
      circuitBreakers: {
        database: dbBreaker.getStatus(),
        aiProvider: aiBreaker.getStatus()
      }
    };
  });

  // Liveness — "is the process itself still running and able to respond."
  // Deliberately checks no external dependency: a database outage should not make
  // an orchestrator conclude this process needs restarting, since restarting it
  // wouldn't fix the database. Always 200 if the process can execute this handler.
  fastify.get('/health/live', { config: { rateLimit: false } }, async () => {
    return { status: 'ok', time: new Date().toISOString() };
  });

  // Readiness — "is this instance able to serve real traffic right now."
  // Unlike the combined /health above, this reflects degraded state in the HTTP
  // status code itself (503 when not ready), so automated consumers (Docker
  // healthcheck, a future load balancer) can act on it without parsing the body.
  fastify.get('/health/ready', { config: { rateLimit: false } }, async (request, reply) => {
    const dbStatus = await checkDatabase();
    const ready = dbStatus === 'connected';
    const body = {
      status: ready ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      database: dbStatus,
      circuitBreakers: {
        database: dbBreaker.getStatus(),
        aiProvider: aiBreaker.getStatus()
      }
    };
    return reply.status(ready ? 200 : 503).send(body);
  });

  // Operational diagnostics — a lightweight, secret-free summary of what this instance
  // is and how it is configured: version/build/runtime metadata, dependency health
  // (database, circuit breakers, live SSE connections), and which optional integrations
  // are configured. For operators diagnosing "what's deployed / why isn't X working".
  // Always 200 (it reports degraded state in the body, like /health); no heavy queries. [M6]
  fastify.get('/health/info', { config: { rateLimit: false } }, async () => {
    const dbStatus = await checkDatabase();
    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      build: buildInfo(),
      dependencies: {
        database: dbStatus,
        circuitBreakers: {
          database: dbBreaker.getStatus(),
          aiProvider: aiBreaker.getStatus()
        },
        sse: getConnectionStats()
      },
      configuration: configStatus()
    };
  });
}

module.exports = healthRoutes;
