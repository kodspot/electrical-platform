'use strict';

/**
 * BUG-0059 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestLocation, createTestTicket, createTestAuditLog } = require('../factories');
const { anonymizeGuestData } = require('../../src/services/cleanup');

const quiet = { info() {}, warn() {}, error() {} };

module.exports = {
  id: 'BUG-0059',
  title: 'After 180 days a guest\'s name was removed from the complaint but kept in its audit row',
  description: 'anonymizeGuestData (services/cleanup.js) nulled guestName and guestPhone on public tickets older than 180 days, but POST /public/complaint also writes the guest\'s name into the ticket_public_create audit row (actorId and newValue.guestName), and that copy was kept for ever. Found by the 2026-10 product and architecture review (PAR-10/19).',
  module: 'complaints',
  category: 'data-exposure',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/19)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-26',
  rootCause: 'The anonymisation job knew only the ticket\'s copy of the name.',
  expectedBehavior: 'The audit row\'s copy is cleared too (actorId "anonymous", no guestName), also for complaints anonymised earlier.',
  brokenBehavior: 'The audit log kept the guest\'s name after the complaint itself had been anonymised.',
  reproductionSteps: [
    'A public complaint with a guest name, older than 180 days.',
    'Run the guest anonymisation job.',
    'Broken: the ticket_public_create audit row still names the guest. Fixed: "anonymous". Test: test/integration/guest-anonymisation.test.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/guest-anonymisation.test.js',

  async apply() {
    const org = await createTestOrg();
    const createdAt = new Date(Date.now() - 200 * 86400000);
    const ticket = await createTestTicket(org.id, (await createTestLocation(org.id)).id, { source: 'PUBLIC', guestName: 'Ravi K', createdAt });
    const row = await createTestAuditLog(org.id, { actorType: 'guest', actorId: 'Ravi K', action: 'ticket_public_create', entityType: 'Ticket', entityId: ticket.id, newValue: { issueType: 'NO_POWER', guestName: 'Ravi K' }, createdAt });
    return { org, row };
  },

  async validate(ctx) {
    const { org, row } = ctx['BUG-0059'];
    await anonymizeGuestData(quiet, { orgId: org.id });
    const after = await ctx.prisma.auditLog.findUnique({ where: { id: row.id } });
    if (after.actorId !== 'anonymous' || (after.newValue && 'guestName' in after.newValue)) return { ok: false, detail: `the audit row still names the guest (${after.actorId})` };
    return { ok: true, detail: 'the guest\'s name is cleared from the audit row too' };
  }
};
