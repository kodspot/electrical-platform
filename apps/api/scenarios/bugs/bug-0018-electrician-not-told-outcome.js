'use strict';

/**
 * BUG-0018 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestWorker } = require('../factories');

module.exports = {
  id: 'BUG-0018',
  title: 'The electrician was never told that their fix was verified, or that it was sent back and why',
  description: 'POST /tickets/:id/verify and POST /tickets/:id/reopen notified only the admins. The code comments said "notify workers", but the electrician who resolved the ticket got nothing: a rejected fix silently reappeared as in-progress, with the supervisor\'s reason visible nowhere in their app.',
  module: 'ele',
  category: 'notification',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (ticket lifecycle, every role)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'tickets.js verify had an empty "Notify workers who resolved it" block; reopen called notifyAdmins under a "notify workers" comment.',
  expectedBehavior: 'Verify notifies the ticket\'s resolving electricians (ticket_verified); reopen does too (ticket_reopened), with the supervisor\'s note.',
  brokenBehavior: 'No Notification row for the electrician on either action.',
  reproductionSteps: [
    'Create two RESOLVED_PENDING_VERIFY tickets resolved by an electrician.',
    'As the admin, verify one and reopen the other with a note.',
    'Broken: the electrician has no notification. Fixed: ticket_verified and ticket_reopened (with the note).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const worker = await createTestWorker(org.id);
    const pending = { status: 'RESOLVED_PENDING_VERIFY', resolvedAt: new Date(), resolvedNote: 'Done', resolvedWorkers: { connect: [{ id: worker.id }] } };
    const toVerify = await createTestTicket(org.id, location.id, pending);
    const toReopen = await createTestTicket(org.id, location.id, pending);
    return { org, admin, worker, toVerify, toReopen };
  },

  async validate(ctx) {
    const { admin, worker, toVerify, toReopen } = ctx['BUG-0018'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.18' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const auth = { authorization: `Bearer ${login.json().token}` };
    const v = await ctx.app.inject({ method: 'POST', url: `/api/tickets/${toVerify.id}/verify`, headers: auth, payload: {} });
    const r = await ctx.app.inject({ method: 'POST', url: `/api/tickets/${toReopen.id}/reopen`, headers: auth, payload: { note: 'Loose cover' } });
    if (v.statusCode !== 200 || r.statusCode !== 200) return { ok: false, detail: `verify ${v.statusCode}, reopen ${r.statusCode}` };
    const find = (entityId, type) => ctx.prisma.notification.findFirst({ where: { workerId: worker.id, entityId, type } });
    let verified, reopened;
    for (let i = 0; i < 40 && !(verified && reopened); i++) {
      [verified, reopened] = await Promise.all([find(toVerify.id, 'ticket_verified'), find(toReopen.id, 'ticket_reopened')]);
      if (!(verified && reopened)) await new Promise((res) => setTimeout(res, 50));
    }
    if (!verified) return { ok: false, detail: 'no ticket_verified notification for the electrician' };
    if (!reopened || !/Loose cover/.test(reopened.body || '')) return { ok: false, detail: 'no ticket_reopened notification with the note' };
    return { ok: true, detail: 'the electrician is told on verify and on reopen' };
  }
};
