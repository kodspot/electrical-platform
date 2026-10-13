'use strict';

/**
 * BUG-0008 — a fixed defect, encoded as a reproducible scenario + regression. [F15]
 */

const { createTestOrg, createTestUser, createTestWorker } = require('../factories');
const { dbBreaker } = require('../../src/lib/circuit-breaker');

module.exports = {
  id: 'BUG-0008',
  title: 'Electrician photo loads opened the database circuit breaker (whole platform 503 for 30 s)',
  description: 'The electrician queue loads ticket photos through /api/images with the worker token. The route looked the token up as a staff user (id: undefined), Prisma threw a validation error, and the database circuit breaker counted it as a database failure. Five such loads within 60 s opened the breaker: every request from every user got 503 for 30 s. Electricians never saw the photos either (401).',
  module: 'ele',
  category: 'resilience',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'Batch 2 e2e journey J7 (finding F15), fixed in C12',
  dateIntroduced: 'WP12 (dbBreaker wired into every Prisma operation)',
  dateFixed: '2026-10-13',
  rootCause: 'dbBreaker counted every error thrown by a Prisma operation, including request-level validation errors; images.js and middleware/auth.js queried user.findUnique({ id: decoded.userId }) for worker tokens, which carry workerId, not userId.',
  expectedBehavior: 'Worker image loads are served (own org) and never count as database failures; an unrelated request right after them succeeds.',
  brokenBehavior: '401 for each photo, and after five of them the next unrelated request answered 503 "Service temporarily unavailable".',
  reproductionSteps: [
    'Sign in as an electrician and GET /api/images/uploads/<orgId>/<file>?token=<worker token> five times.',
    'Make any unrelated request, e.g. an admin listing locations.',
    'Broken: 503 (database breaker OPEN). Fixed: 200, breaker CLOSED.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const worker = await createTestWorker(org.id, { pin: '135792' });
    return { org, admin, worker };
  },

  async validate(ctx) {
    const { org, admin, worker } = ctx['BUG-0008'];
    try {
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '135792' } });
      if (login.statusCode !== 200) return { ok: false, detail: `worker-login expected 200, got ${login.statusCode}` };
      const token = login.json().token;
      for (let i = 0; i < 5; i++) {
        await ctx.app.inject({ method: 'GET', url: `/api/images/uploads/${org.id}/bug-0008-${i}.webp?token=${token}` });
      }
      if (dbBreaker.state !== 'CLOSED') return { ok: false, detail: `database breaker is ${dbBreaker.state} after five worker image loads` };
      const staff = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: admin.plaintextPassword } });
      if (staff.statusCode !== 200) return { ok: false, detail: `the unrelated request (staff login) answered ${staff.statusCode}` };
      return { ok: true, detail: 'five worker image loads left the breaker CLOSED; the next unrelated request succeeded' };
    } finally {
      // Never leave the shared breaker open for the rest of this process.
      dbBreaker.state = 'CLOSED';
      dbBreaker.failures = [];
    }
  }
};
