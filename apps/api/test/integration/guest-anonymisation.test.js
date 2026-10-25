'use strict';

// After 180 days a guest's name and phone are removed from their complaint (DPDP). The name
// was also copied into the complaint's audit row — as its actorId and newValue.guestName — and
// stayed there. The job now clears that copy too, including rows of complaints anonymised
// before this fix. [BUG-0059]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestLocation, createTestTicket, createTestAuditLog } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { anonymizeGuestData } = require('../../src/services/cleanup');

const quiet = { info() {}, warn() {}, error() {} };
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

describe('BUG-0059: guest anonymisation also clears the name copied into the audit log', () => {
  let dbAvailable = false;
  let org, oldTicket, oldRow, earlierRow, recentTicket, recentRow;
  const createdOrgIds = [];

  const complaint = async (createdAt, guestName) => {
    const ticket = await createTestTicket(org.id, (await createTestLocation(org.id)).id, { source: 'PUBLIC', guestName, guestPhone: guestName ? '+91 98765 43210' : null, createdAt });
    const row = await createTestAuditLog(org.id, {
      actorType: 'guest', actorId: 'Asha Rao', action: 'ticket_public_create', entityType: 'Ticket', entityId: ticket.id,
      newValue: { issueType: 'NO_POWER', locationName: 'Room 12', guestName: 'Asha Rao' }, createdAt
    });
    return { ticket, row };
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    ({ ticket: oldTicket, row: oldRow } = await complaint(daysAgo(200), 'Asha Rao'));
    // Anonymised by an earlier run: the ticket is clean, its audit row is not.
    ({ row: earlierRow } = await complaint(daysAgo(400), null));
    ({ ticket: recentTicket, row: recentRow } = await complaint(daysAgo(10), 'Asha Rao'));
    await anonymizeGuestData(quiet, { orgId: org.id });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('a complaint older than 180 days loses the name and phone on the ticket and in its audit row', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await prisma.ticket.findUnique({ where: { id: oldTicket.id } });
    assert.strictEqual(ticket.guestName, null);
    assert.strictEqual(ticket.guestPhone, null);
    const row = await prisma.auditLog.findUnique({ where: { id: oldRow.id } });
    assert.strictEqual(row.actorId, 'anonymous');
    assert.deepStrictEqual(row.newValue, { issueType: 'NO_POWER', locationName: 'Room 12' });
  });

  it('the audit row of a complaint anonymised before this fix is cleared too', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const row = await prisma.auditLog.findUnique({ where: { id: earlierRow.id } });
    assert.strictEqual(row.actorId, 'anonymous');
    assert.ok(!('guestName' in row.newValue));
  });

  it('a recent complaint keeps its name everywhere', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    assert.strictEqual((await prisma.ticket.findUnique({ where: { id: recentTicket.id } })).guestName, 'Asha Rao');
    assert.strictEqual((await prisma.auditLog.findUnique({ where: { id: recentRow.id } })).actorId, 'Asha Rao');
  });
});
