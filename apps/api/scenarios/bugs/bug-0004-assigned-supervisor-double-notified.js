'use strict';

/**
 * BUG-0004 — a fixed defect, encoded as a reproducible scenario + regression. [WP-H F3]
 */

const { createTestOrg, createTestUser, createTestLocation, createTestSupervisorAssignment } = require('../factories');

async function settledCount(prisma, where) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const n = await prisma.notification.count({ where });
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (n > 0 && stable >= 3) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

module.exports = {
  id: 'BUG-0004',
  title: 'A supervisor assigned to a location got two notifications per public complaint',
  description: 'On a public complaint, the location\'s assigned supervisors received the direct "assigned" notification and also the org-wide supervisor broadcast for the same ticket.',
  module: 'complaints',
  category: 'notification',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'QA-1 characterisation finding F3 (docs/testing/COVERAGE_MATRIX.md), fixed in [WP-H]',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-13',
  rootCause: 'POST /public/complaint called createNotification for each assigned supervisor and then notifySupervisors, which notifies every active supervisor in the org — including the assigned ones.',
  expectedBehavior: 'An assigned supervisor gets exactly one notification for the complaint (the direct one); every other supervisor in the org gets the broadcast once.',
  brokenBehavior: 'The assigned supervisor got two notifications for the same ticket.',
  reproductionSteps: [
    'Create an org with a location, a supervisor assigned to it, and an unassigned supervisor.',
    'Submit a public complaint for the location.',
    'Broken: the assigned supervisor has 2 notifications for the ticket. Fixed: exactly 1; the unassigned supervisor has 1.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    const assigned = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, assigned.id, location.id);
    const unassigned = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const ip = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    return { org, locationId: location.id, assigned, unassigned, ip };
  },

  async validate(ctx) {
    const { locationId, assigned, unassigned, ip } = ctx['BUG-0004'];
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/public/complaint',
      headers: { 'x-forwarded-for': ip },
      payload: { locationId, issueType: 'LIGHT_NOT_WORKING' }
    });
    if (res.statusCode !== 200) return { ok: false, detail: `complaint expected 200, got ${res.statusCode}` };
    const ticketId = res.json().ticket.id;
    const toUnassigned = await settledCount(ctx.prisma, { userId: unassigned.id, entityId: ticketId });
    const toAssigned = await settledCount(ctx.prisma, { userId: assigned.id, entityId: ticketId });
    if (toAssigned !== 1) return { ok: false, detail: `assigned supervisor expected 1 notification, got ${toAssigned}` };
    if (toUnassigned !== 1) return { ok: false, detail: `unassigned supervisor expected 1 notification, got ${toUnassigned}` };
    return { ok: true, detail: 'assigned supervisor notified once (direct), unassigned once (broadcast)' };
  }
};
