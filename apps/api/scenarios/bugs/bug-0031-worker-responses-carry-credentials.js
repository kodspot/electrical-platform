'use strict';

/**
 * BUG-0031 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestUser, createTestWorker } = require('../factories');

module.exports = {
  id: 'BUG-0031',
  title: 'Worker detail, create and update responses carried the PIN hash and a pending PIN-reset token',
  description: 'GET /api/workers/:id, POST /api/workers, PATCH /api/workers/:id and the super-admin worker create/update routes returned the whole Worker row: pinHash, resetToken (a pending token sets the electrician\'s PIN), resetTokenExpiresAt and tokenInvalidBefore. The list routes already used an explicit select. Found by the 2026-10 product and architecture review (PAR-10/16).',
  module: 'ele',
  category: 'data-exposure',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/16)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'Those routes read and wrote Worker without a select, so Prisma returned every column.',
  expectedBehavior: 'They return WORKER_PROFILE_SELECT (lib/security.js): the profile, no credential material.',
  brokenBehavior: 'The JSON contained pinHash (a bcrypt hash) and resetToken.',
  reproductionSteps: [
    'Create an electrician with a PIN and a pending PIN-reset token.',
    'As the org admin, GET /api/workers/:id.',
    'Broken: pinHash and resetToken are in the response. Fixed: neither key is present.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/worker-credentials.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const worker = await createTestWorker(org.id, { pin: '531031' });
    const { prisma } = require('../../src/lib/prisma');
    const resetToken = crypto.randomBytes(32).toString('hex');
    await prisma.worker.update({ where: { id: worker.id }, data: { resetToken, resetTokenExpiresAt: new Date(Date.now() + 3600000) } });
    return { admin, worker, resetToken };
  },

  async validate(ctx) {
    const { admin, worker, resetToken } = ctx['BUG-0031'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.31' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'GET', url: `/api/workers/${worker.id}`, headers: { authorization: `Bearer ${login.json().token}` } });
    if (res.statusCode !== 200) return { ok: false, detail: `expected 200, got ${res.statusCode}` };
    const leaked = ['pinHash', 'resetToken', 'resetTokenExpiresAt', 'tokenInvalidBefore'].filter((k) => k in res.json());
    if (leaked.length || res.body.includes(resetToken)) return { ok: false, detail: `the response carries ${leaked.join(', ') || 'the reset token'}` };
    return { ok: true, detail: 'the worker detail carries the profile and no credential material' };
  }
};
