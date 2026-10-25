'use strict';

/**
 * BUG-0046 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const jwt = require('jsonwebtoken');
const { createTestOrg, createTestUser } = require('../factories');

module.exports = {
  id: 'BUG-0046',
  title: 'Token verification accepted any HMAC algorithm, not just the HS256 the app signs',
  description: 'All four jwt.verify sites (middleware/auth.js, worker-auth.js, images.js, the worker notification stream) passed no algorithms option, so jsonwebtoken accepted HS256, HS384 and HS512 for the shared secret. Not exploitable with one symmetric secret, but the allow-list is standard defence in depth (OWASP ASVS V9) and was open as PRA-07 L3. Found by the 2026-10 product and architecture review (PAR-10/35).',
  module: 'ele',
  category: 'data-exposure',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Production readiness audit 2026-07 (L3); product and architecture review 2026-10 (PAR-10/35)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'jwt.verify(token, secret) without { algorithms }.',
  expectedBehavior: 'Every verify pins { algorithms: [\'HS256\'] } (JWT_VERIFY_OPTIONS); a token signed otherwise answers 401.',
  brokenBehavior: 'An HS512-signed token for a real user answered 200 on /api/auth/me.',
  reproductionSteps: [
    'Sign { userId, orgId, role } with JWT_SECRET using HS512.',
    'GET /api/auth/me with it.',
    'Broken: 200. Fixed: 401.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/jwt-algorithms.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    return { org, admin };
  },

  async validate(ctx) {
    const { org, admin } = ctx['BUG-0046'];
    const token = jwt.sign({ userId: admin.id, orgId: org.id, role: 'ADMIN' }, process.env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '5m' });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    if (res.statusCode !== 401) return { ok: false, detail: `an HS512 token answered ${res.statusCode}` };
    return { ok: true, detail: 'only HS256 tokens are accepted' };
  }
};
