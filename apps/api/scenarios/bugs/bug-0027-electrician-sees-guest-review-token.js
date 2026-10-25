'use strict';

/**
 * BUG-0027 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestWorker, createTestWorkerAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0027',
  title: 'The electrician API returned the guest\'s review token, name, phone, IP hash and user agent',
  description: 'Every electrician ticket route (list, detail, pool, my work, pickup, resolve) read tickets with a bare Prisma `include`, which returns every column. The response carried the guest\'s secret review token — with it, the electrician who did the work could "confirm as the resident" and close it — and the guest\'s name, phone, IP hash, user agent and risk score. The staff routes strip the token; the electrician routes did not. Found by the 2026-10 product and architecture review (PAR-10/14).',
  module: 'ele',
  category: 'data-exposure',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/14)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'worker-auth.js used `include` (all scalar columns + relations) instead of an explicit `select` for every ticket it returns.',
  expectedBehavior: 'Electrician ticket responses carry only the fields the electrician app uses; no review token or guest personal data.',
  brokenBehavior: 'GET /api/worker/tickets/:id returned reviewToken, guestName, guestPhone, sourceIp, userAgent and riskScore.',
  reproductionSteps: [
    'Create an org, a location, an electrician covering it, and a PUBLIC ticket awaiting guest review there, with guest name and phone.',
    'As the electrician, GET /api/worker/tickets/:id.',
    'Broken: the JSON contains reviewToken and guestPhone. Fixed: neither key is present.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id, { pin: '527027' });
    await createTestWorkerAssignment(org.id, worker.id, location.id);
    const ticket = await createTestTicket(org.id, location.id, {
      source: 'PUBLIC', status: 'RESOLVED', guestName: 'BUG0027 Resident', guestPhone: '9000027027',
      verifiedAt: new Date(), verifiedById: supervisor.id, resolvedAt: new Date(),
      reviewToken: crypto.randomBytes(32).toString('hex'), reviewStatus: 'PENDING',
      reviewExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    return { org, worker, ticket };
  },

  async validate(ctx) {
    const { org, worker, ticket } = ctx['BUG-0027'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': '10.94.0.27' }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    if (login.statusCode !== 200) return { ok: false, detail: `worker login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'GET', url: `/api/worker/tickets/${ticket.id}`, headers: { authorization: `Bearer ${login.json().token}` } });
    if (res.statusCode !== 200) return { ok: false, detail: `expected 200, got ${res.statusCode}` };
    const leaked = ['reviewToken', 'guestName', 'guestPhone', 'sourceIp', 'userAgent', 'riskScore'].filter((k) => k in res.json());
    if (leaked.length || res.body.includes(ticket.reviewToken)) return { ok: false, detail: `the response carries ${leaked.join(', ') || 'the review token'}` };
    return { ok: true, detail: 'the electrician sees the ticket without the review token or guest data' };
  }
};
