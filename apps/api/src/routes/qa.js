'use strict';

/**
 * POST /api/qa/runs — test-run ingest for the super-admin Quality page. [WP-Q, ADR 0005]
 *
 * Deliberately outside authenticateJWT: the caller is CI, not a user. It authenticates with a
 * shared secret, QA_INGEST_TOKEN, sent as `Authorization: Bearer <token>`:
 *   - token unset on the server → 404 (the endpoint does not exist);
 *   - wrong or missing token    → 401, compared in constant time;
 *   - body over 256 KB          → 413; invalid body → 400. Nothing from the request is echoed.
 * Stored rows are platform-level (QaRun is not tenant-scoped) and pruned to the newest 500.
 */

const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { scrubJwtShapes } = require('../lib/log-redaction');

const KEEP_NEWEST = 500;
const BODY_LIMIT = 256 * 1024;
const DETAIL_STRING_MAX = 1000;
const ARRAY_CAPS = { failures: 100, files: 300, tiers: 30, journeys: 100, reasons: 20, pages: 100 };

const str = (max) => z.string().trim().transform((s) => s.slice(0, max));
const optStr = (max) => str(max).optional().nullable();
const count = z.number().int().nonnegative().max(10_000_000);

const bodySchema = z.object({
  source: z.enum(['ci', 'local', 'e2e']),
  commitSha: optStr(64),
  ref: optStr(200),
  event: optStr(64),
  runUrl: z.string().trim().max(500).url().refine((u) => u.startsWith('https://'), 'runUrl must be https').optional().nullable(),
  nodeVersion: optStr(32),
  summary: z.object({
    status: str(40),
    counts: z.object({
      tests: count, pass: count, fail: count,
      cancelled: count.default(0), skipped: count.default(0), todo: count.default(0)
    }).passthrough(),
    durationMs: z.number().nonnegative().max(1e9).nullable().optional()
  }).passthrough()
});

/** Bounded copy of the summary for QaRun.details: capped arrays, truncated + scrubbed strings, depth ≤ 5. */
function trimDetails(value, key = '', depth = 0) {
  if (typeof value === 'string') return scrubJwtShapes(value.trim().slice(0, DETAIL_STRING_MAX));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 5) return null;
  if (Array.isArray(value)) {
    const cap = ARRAY_CAPS[key] || 50;
    return value.slice(0, cap).map((v) => trimDetails(v, '', depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k.slice(0, 64)] = trimDetails(v, k, depth + 1);
    return out;
  }
  return null;
}

function tokenMatches(authorization, expected) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization || '');
  if (!m) return false;
  const given = crypto.createHash('sha256').update(m[1]).digest();
  const want = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(given, want);
}

/** Insert one run and prune to the newest KEEP_NEWEST, atomically. */
async function recordQaRun(data, { keep = KEEP_NEWEST } = {}) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.qaRun.create({ data, select: { id: true } });
    const stale = await tx.qaRun.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: keep,
      select: { id: true }
    });
    if (stale.length) await tx.qaRun.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    return created;
  });
}

async function qaRoutes(fastify) {
  fastify.post('/qa/runs', {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: { max: 10, timeWindow: 60_000, keyGenerator: (req) => req.ip } }
  }, async (request, reply) => {
    const expected = process.env.QA_INGEST_TOKEN;
    if (!expected) return reply.code(404).send({ error: 'Not found' });
    if (!tokenMatches(request.headers.authorization, expected)) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid payload' });
    const b = parsed.data;
    const c = b.summary.counts;

    const run = await recordQaRun({
      source: b.source,
      commitSha: b.commitSha || null,
      ref: b.ref || null,
      event: b.event || null,
      runUrl: b.runUrl || null,
      nodeVersion: b.nodeVersion || null,
      status: b.summary.status,
      total: c.tests,
      passed: c.pass,
      failed: c.fail,
      cancelled: c.cancelled,
      skipped: c.skipped,
      todo: c.todo,
      durationMs: typeof b.summary.durationMs === 'number' ? Math.round(b.summary.durationMs) : null,
      details: trimDetails(b.summary)
    });
    return reply.code(201).send({ id: run.id });
  });
}

module.exports = qaRoutes;
module.exports.recordQaRun = recordQaRun;
module.exports.trimDetails = trimDetails;
module.exports.KEEP_NEWEST = KEEP_NEWEST;
