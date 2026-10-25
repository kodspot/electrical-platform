'use strict';

/**
 * BUG-0032 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser } = require('../factories');

module.exports = {
  id: 'BUG-0032',
  title: 'An org admin\'s "run escalations" escalated every tenant\'s alerts, outside the scheduler lock',
  description: 'POST /api/alerts/run-checks and /api/alerts/run-escalations (ORG_ADMIN) started the platform-wide jobs: every organization\'s scheduled checks and escalations. They ran outside the scheduler\'s advisory lock, so next to the 5-minute scheduled run the same alert could escalate twice. The escalation scan also escalated alerts of suspended and deleted organizations. Found by the 2026-10 product and architecture review (PAR-10/01, PAR-10/42).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/01, PAR-10/42)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The routes called runScheduledChecks / runEscalationChecks with no org scope and without runExclusive; the escalation rule query had no organization-status filter.',
  expectedBehavior: 'A manual run covers the caller\'s org only, under the scheduled job\'s lock (409 while it is held); suspended and deleted orgs never escalate.',
  brokenBehavior: 'Org A\'s admin calling run-escalations escalated org B\'s overdue alert.',
  reproductionSteps: [
    'Create two orgs, each with a rule that escalates after 1 minute and an unacknowledged alert 30 minutes old.',
    'As org A\'s admin, POST /api/alerts/run-escalations.',
    'Broken: org B\'s alert reaches escalation level 1. Fixed: it stays at 0; org A\'s escalates.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/alert-manual-checks.test.js',

  async apply() {
    const { prisma } = require('../../src/lib/prisma');
    const org = await createTestOrg();
    const other = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    // The other org's alert is overdue for escalation: any run that ignores the org scope
    // escalates it. (The suite's own escalation runs are scoped to their orgs.)
    const rule = await prisma.alertRule.create({ data: { orgId: other.id, name: '__wp1_test__ BUG-0032 rule', trigger: 'TICKET_HIGH_PRIORITY', conditions: {}, actions: [], escalateAfterMinutes: 1, escalationActions: [], maxEscalations: 1 } });
    const alert = await prisma.alert.create({ data: { orgId: other.id, ruleId: rule.id, trigger: 'TICKET_HIGH_PRIORITY', title: '__wp1_test__ BUG-0032 alert', createdAt: new Date(Date.now() - 30 * 60 * 1000) } });
    return { org, other, admin, alert };
  },

  async validate(ctx) {
    const { other, admin, alert } = ctx['BUG-0032'];
    try {
      const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.32' }, payload: { email: admin.email, password: admin.plaintextPassword } });
      if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
      const res = await ctx.app.inject({ method: 'POST', url: '/api/alerts/run-escalations', headers: { authorization: `Bearer ${login.json().token}` } });
      if (res.statusCode !== 200 && res.statusCode !== 409) return { ok: false, detail: `run-escalations answered ${res.statusCode}` };
      await new Promise((r) => setTimeout(r, 500));
      const now = await ctx.prisma.alert.findUnique({ where: { id: alert.id } });
      if (now.escalationLevel !== 0) return { ok: false, detail: 'another org\'s alert was escalated' };
      return { ok: true, detail: 'the manual run stayed inside the caller\'s org' };
    } finally {
      // The runner cleans up ctx[id].org; the second org is this scenario's to remove.
      await ctx.prisma.organization.deleteMany({ where: { id: other.id } });
    }
  }
};
