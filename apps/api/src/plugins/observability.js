'use strict';

/**
 * Request-correlation and slow-request observability. [platform-M6]
 *
 * Reuses Fastify's existing request id (index.js's genReqId) and the existing pino
 * request-scoped logger — it does NOT introduce a second logging or monitoring system.
 * Two additive hooks:
 *   1. Expose the request id on every response as `x-request-id`, so a client or operator
 *      can correlate any request (success OR error) with its server logs. Error responses
 *      already carry `requestId` in the body; this extends correlation to successful
 *      responses and to standard tooling that reads the header.
 *   2. Log requests slower than a threshold (default 2000ms) at `warn`, so a production
 *      latency problem is visible without enabling per-request logging (which is
 *      deliberately off in production). Long-lived SSE streams are excluded.
 */

const SLOW_REQUEST_MS = parseInt(process.env.SLOW_REQUEST_MS, 10) || 2000;

function registerObservability(fastify) {
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    try {
      // SSE streams (/notifications/stream, /notifications/worker-stream) are intentionally
      // long-lived; their close time is not a "slow request".
      if (!request.url.includes('/stream')) {
        const ms = reply.elapsedTime;
        if (typeof ms === 'number' && ms >= SLOW_REQUEST_MS) {
          request.log.warn(
            { reqId: request.id, method: request.method, url: request.url, statusCode: reply.statusCode, durationMs: Math.round(ms) },
            'slow request'
          );
        }
      }
    } catch { /* observability must never break a response */ }
    done();
  });
}

module.exports = { registerObservability };
