'use strict';

/**
 * BUG-0034 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser } = require('../factories');

module.exports = {
  id: 'BUG-0034',
  title: 'Password and PIN reset tokens were stored as issued, so the database value itself reset the account',
  description: 'POST /api/auth/forgot-password and /api/auth/worker-forgot-pin stored the e-mailed reset token unchanged in User.resetToken / Worker.resetToken, and the reset routes looked it up as is. Anyone who could read the database or a backup could reset the password or PIN of any account with a pending request. Found by the 2026-10 product and architecture review (PAR-10/21).',
  module: 'ele',
  category: 'account-recovery',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/21)',
  dateIntroduced: '2026-07-21 ([WP14])',
  dateFixed: '2026-10-25',
  rootCause: 'The [WP14] recovery pattern stored the raw token; nothing hashed it before the write or the lookup.',
  expectedBehavior: 'Only the token\'s SHA-256 digest is stored (hashResetToken); the stored value submitted as a token is refused.',
  brokenBehavior: 'Submitting User.resetToken from the database to /api/auth/reset-password changed the password (200).',
  reproductionSteps: [
    'POST /api/auth/forgot-password for an existing staff email.',
    'Read User.resetToken from the database and POST it to /api/auth/reset-password with a new password.',
    'Broken: 200, password changed. Fixed: 400.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/account-recovery.test.js',

  async apply() {
    const org = await createTestOrg();
    const user = await createTestUser(org.id, { role: 'ADMIN' });
    return { org, user };
  },

  async validate(ctx) {
    const { user } = ctx['BUG-0034'];
    const forgot = await ctx.app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: '10.94.0.34', payload: { email: user.email } });
    if (forgot.statusCode !== 200) return { ok: false, detail: `forgot-password answered ${forgot.statusCode}` };
    const { resetToken } = await ctx.prisma.user.findUnique({ where: { id: user.id }, select: { resetToken: true } });
    if (!resetToken) return { ok: false, detail: 'no reset token was issued' };
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/reset-password', remoteAddress: '10.94.0.34', payload: { token: resetToken, newPassword: 'FromTheDb1234' } });
    if (res.statusCode === 200) return { ok: false, detail: 'the value stored in the database reset the password' };
    return { ok: true, detail: 'only a digest is stored; it does not work as a token' };
  }
};
