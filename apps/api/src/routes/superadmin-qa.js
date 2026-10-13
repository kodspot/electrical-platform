'use strict';

/**
 * Super-admin Quality page API. [WP-Q, ADR 0005]
 * SUPER_ADMIN only, through the existing auth stack (authenticateJWT + requirePolicy).
 *
 *   GET  /superadmin/qa/runs           paginated test runs (no details)
 *   GET  /superadmin/qa/runs/:id       one run, with its details (tiers, files, failures)
 *   GET  /superadmin/qa/trend          the latest N runs, oldest first, for the trend chart
 *   GET  /superadmin/qa/ci-status      latest GitHub Actions runs (cached 60 s)
 *   POST /superadmin/qa/checks         live read-only production checks, streamed as NDJSON
 *   POST /superadmin/qa/dispatch       start the e2e workflow on GitHub ("Run full test suite now")
 */

const { PassThrough } = require('stream');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requirePolicy } = require('../middleware/auth');
const { getCiStatus, dispatchE2eWorkflow } = require('../lib/github');
const { runProductionChecks } = require('../services/production-checks');

const SOURCES = new Set(['ci', 'local', 'e2e']);

// What the page shows for each dispatch outcome, and the status this API answers with.
const DISPATCH = {
  started: { code: 202, message: 'started' },
  not_on_main: { code: 409, message: 'the e2e workflow is not on main yet: it only becomes dispatchable after batch-2 is merged' },
  token_rejected: { code: 502, message: 'dispatch token invalid, expired, or missing Actions write' },
  github_unavailable: { code: 503, message: 'GitHub unavailable, try later' }
};
const dispatchEnabled = () => Boolean(process.env.GH_ACTIONS_DISPATCH_TOKEN);
const LIST_SELECT = {
  id: true, createdAt: true, source: true, commitSha: true, ref: true, event: true, runUrl: true,
  nodeVersion: true, status: true, total: true, passed: true, failed: true, cancelled: true,
  skipped: true, todo: true, durationMs: true
};

function intParam(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function superadminQaRoutes(fastify) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requirePolicy('SUPER_ADMIN'));

  fastify.get('/superadmin/qa/runs', async (request) => {
    const page = intParam(request.query.page, { min: 1, max: 1000, fallback: 1 });
    const limit = intParam(request.query.limit, { min: 1, max: 100, fallback: 20 });
    const where = SOURCES.has(request.query.source) ? { source: request.query.source } : {};
    const [runs, total] = await Promise.all([
      prisma.qaRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: LIST_SELECT }),
      prisma.qaRun.count({ where })
    ]);
    return { runs, total, page, limit };
  });

  fastify.get('/superadmin/qa/runs/:id', async (request, reply) => {
    const run = await prisma.qaRun.findUnique({ where: { id: request.params.id } });
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return run;
  });

  fastify.get('/superadmin/qa/trend', async (request) => {
    const limit = intParam(request.query.limit, { min: 1, max: 100, fallback: 30 });
    const where = SOURCES.has(request.query.source) ? { source: request.query.source } : {};
    const runs = await prisma.qaRun.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, createdAt: true, source: true, status: true, total: true, passed: true, failed: true, cancelled: true, skipped: true, todo: true, durationMs: true }
    });
    return { runs: runs.reverse() };
  });

  // dispatchEnabled tells the page whether to offer "Run full test suite now".
  fastify.get('/superadmin/qa/ci-status', async () => ({ ...(await getCiStatus()), dispatchEnabled: dispatchEnabled() }));

  // "Run full test suite now": dispatch the e2e workflow on main. Feature off (404) while
  // GH_ACTIONS_DISPATCH_TOKEN is unset. One dispatch per 10 minutes. The token is only ever
  // sent to GitHub — never returned, logged or audited; the audit row holds statuses only.
  fastify.post('/superadmin/qa/dispatch', {
    config: { rateLimit: { max: 1, timeWindow: 600_000, keyGenerator: (req) => req.ip } }
  }, async (request, reply) => {
    if (!dispatchEnabled()) return reply.code(404).send({ error: 'Not found' });
    const result = await dispatchE2eWorkflow({ requestedBy: 'superadmin' });
    const outcome = DISPATCH[result.outcome] ? result.outcome : 'github_unavailable';
    await prisma.auditLog.create({
      data: {
        orgId: null,
        actorType: 'super_admin',
        actorId: request.user.id,
        action: 'sa_test_suite_dispatched',
        entityType: 'Platform',
        newValue: { outcome, githubStatus: result.githubStatus }
      }
    }).catch((err) => request.log.warn({ err: err.message }, 'dispatch audit write failed'));
    const { code, message } = DISPATCH[outcome];
    return reply.code(code).send({ state: outcome, message, url: outcome === 'started' ? result.url : null });
  });

  // Streams one JSON object per line as each check finishes, then a final { done } line.
  // Authorization travels in the request header (fetch + ReadableStream on the page) — never
  // in a URL, and no EventSource (which cannot send headers).
  fastify.post('/superadmin/qa/checks', {
    config: { rateLimit: { max: 1, timeWindow: 30_000, keyGenerator: (req) => req.ip } }
  }, async (request, reply) => {
    const stream = new PassThrough();
    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.header('Cache-Control', 'no-store');

    (async () => {
      const results = await runProductionChecks({
        onResult: (r) => stream.write(`${JSON.stringify(r)}\n`)
      });
      const tally = { PASS: 0, WARN: 0, FAIL: 0, SKIPPED: 0 };
      for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
      stream.write(`${JSON.stringify({ done: true, tally })}\n`);
      stream.end();
      await prisma.auditLog.create({
        data: {
          orgId: null,
          actorType: 'super_admin',
          actorId: request.user.id,
          action: 'sa_production_checks_run',
          entityType: 'Platform',
          newValue: { statuses: results.map((r) => ({ name: r.name, status: r.status })) }
        }
      });
    })().catch((err) => {
      request.log.warn({ err: err.message }, 'production checks failed');
      if (!stream.writableEnded) {
        stream.write(`${JSON.stringify({ done: true, error: 'checks aborted' })}\n`);
        stream.end();
      }
    });

    return reply.send(stream);
  });
}

module.exports = superadminQaRoutes;
