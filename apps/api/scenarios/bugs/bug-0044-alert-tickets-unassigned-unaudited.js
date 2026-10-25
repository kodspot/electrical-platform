'use strict';

/**
 * BUG-0044 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestSupervisorAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0044',
  title: 'Tickets raised by an alert rule were unassigned, had no SLA deadline, no audit row, and nobody was told',
  description: 'An alert rule\'s CREATE_TICKET action (directly or on escalation) created a bare ticket: no assignee (so no supervisor saw it), no slaDeadlineAt, no AuditLog row, no notification — unlike every ticket staff raise. The action\'s priority was never checked, so a rule saved with an unknown priority failed at the moment it fired. Found by the 2026-10 product and architecture review (PAR-10/06).',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/06)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'automation.js created the ticket with a bare prisma.ticket.create; alerts.js accepted any string as a ticket priority.',
  expectedBehavior: 'The ticket is assigned to the supervisor covering the location, has an SLA deadline, is audited (ticket_created_by_alert) and the assignee is notified; rule saves refuse an unknown priority (400).',
  brokenBehavior: 'assignedToId and slaDeadlineAt null; no audit row; a rule with priority "SUPER" saved (201).',
  reproductionSteps: [
    'Create a rule on TICKET_HIGH_PRIORITY whose action is CREATE_TICKET, at a location a supervisor covers.',
    'Raise a HIGH ticket there so the rule fires.',
    'Broken: the [Auto] ticket has no assignee. Fixed: the covering supervisor holds it.'
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
    const { org, admin, supervisor, location } = ctx['BUG-0044'];
    const token = await ctx.loginAs(admin.email, admin.plaintextPassword);
    const headers = { authorization: `Bearer ${token}` };
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/alert-rules', headers, payload: { name: 'bad', trigger: 'TICKET_HIGH_PRIORITY', conditions: {}, actions: [{ type: 'CREATE_TICKET', priority: 'SUPER' }] } });
    if (bad.statusCode !== 400) return { ok: false, detail: `a rule with an unknown priority answered ${bad.statusCode}` };
    const rule = await ctx.app.inject({ method: 'POST', url: '/api/alert-rules', headers, payload: { name: 'auto ticket', trigger: 'TICKET_HIGH_PRIORITY', conditions: {}, actions: [{ type: 'CREATE_TICKET', priority: 'URGENT' }] } });
    if (![200, 201].includes(rule.statusCode)) return { ok: false, detail: `rule create answered ${rule.statusCode}` };
    const created = await ctx.app.inject({ method: 'POST', url: '/api/tickets', headers, payload: { locationId: location.id, title: 'BUG-0044 smoke', priority: 'HIGH' } });
    if (created.statusCode !== 200) return { ok: false, detail: `ticket create answered ${created.statusCode}` };
    let auto = null;
    for (let i = 0; i < 40 && !auto; i++) {
      auto = await ctx.prisma.ticket.findFirst({ where: { orgId: org.id, title: { startsWith: '[Auto] ' } } });
      if (!auto) await new Promise((r) => setTimeout(r, 50));
    }
    if (!auto) return { ok: false, detail: 'the rule raised no ticket' };
    if (auto.assignedToId !== supervisor.id || !auto.slaDeadlineAt) return { ok: false, detail: `the [Auto] ticket: assignee ${auto.assignedToId}, SLA ${auto.slaDeadlineAt}` };
    return { ok: true, detail: 'the [Auto] ticket is assigned, has an SLA deadline, and bad priorities are refused' };
  }
};
