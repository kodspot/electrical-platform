'use strict';

/**
 * BUG-0019 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestSupervisorAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0019',
  title: 'Alert escalations never reached the supervisors or electricians of the location, nor raised their ticket',
  description: 'An alert rule can escalate an unacknowledged alert to the supervisors and electricians assigned to the location, and raise a ticket there. The escalation engine reads the location from the stored alert (metadata.locationId), but no alert ever stored it: the event payloads carry locationId at the top level and fireAlert kept only data.metadata. Every such escalation silently reached no one; only the generic "escalation" notice to the admins went out.',
  module: 'ele',
  category: 'notification',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (scheduler: ESCALATION_CHECKS)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'services/automation.js fireAlert stored `metadata: data.metadata || null`; runEscalationChecks passes `alert.metadata?.locationId` to the escalation actions, which return early without a location.',
  expectedBehavior: 'An alert raised for a location records it (metadata.locationId/module), so NOTIFY_ASSIGNED_SUPERVISORS, NOTIFY_ASSIGNED_WORKERS and CREATE_TICKET work on escalation.',
  brokenBehavior: 'The escalated alert notified no supervisor or electrician of the location and raised no ticket.',
  reproductionSteps: [
    'Create an org, a location with an assigned supervisor, and a TICKET_HIGH_PRIORITY rule escalating after 10 minutes to NOTIFY_ASSIGNED_SUPERVISORS.',
    'As the admin, POST /api/tickets with priority HIGH; back-date the alert 11 minutes; run runEscalationChecks().',
    'Broken: the supervisor has no notification for the alert. Fixed: one.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/alert-escalation.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const location = await createTestLocation(org.id);
    await createTestSupervisorAssignment(org.id, supervisor.id, location.id);
    return { org, admin, supervisor, location };
  },

  async validate(ctx) {
    const { org, admin, supervisor, location } = ctx['BUG-0019'];
    const { runEscalationChecks } = require('../../src/services/automation');
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.19' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const auth = { authorization: `Bearer ${login.json().token}` };
    const rule = await ctx.app.inject({
      method: 'POST', url: '/api/alert-rules', headers: auth,
      payload: { name: 'Escalate', trigger: 'TICKET_HIGH_PRIORITY', actions: [{ type: 'NOTIFY_ADMINS' }], escalateAfterMinutes: 10, escalationActions: [{ type: 'NOTIFY_ASSIGNED_SUPERVISORS' }] }
    });
    if (![200, 201].includes(rule.statusCode)) return { ok: false, detail: `rule create answered ${rule.statusCode}` };
    const ticket = await ctx.app.inject({ method: 'POST', url: '/api/tickets', headers: auth, payload: { locationId: location.id, title: 'Sparking socket', priority: 'HIGH' } });
    if (ticket.statusCode !== 200) return { ok: false, detail: `ticket create answered ${ticket.statusCode}` };
    let alert = null;
    for (let i = 0; i < 40 && !alert; i++) {
      alert = await ctx.prisma.alert.findFirst({ where: { orgId: org.id, entityId: ticket.json().id } });
      if (!alert) await new Promise((r) => setTimeout(r, 50));
    }
    if (!alert) return { ok: false, detail: 'the HIGH ticket raised no alert' };
    await ctx.prisma.alert.update({ where: { id: alert.id }, data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) } });
    await runEscalationChecks();
    const reached = await ctx.prisma.notification.count({ where: { userId: supervisor.id, entityId: alert.id } });
    if (reached !== 1) return { ok: false, detail: `the location's supervisor got ${reached} escalation notifications` };
    return { ok: true, detail: 'the escalation reached the location\'s supervisor' };
  }
};
