'use strict';

/**
 * Scenario: Ticket Workflow. [platform-M3, DPS §4]
 * Tickets spanning the lifecycle statuses, internal and public sources.
 */

const { createTestTicket } = require('./factories');

async function apply(ctx) {
  const { org, rooms, supervisors } = ctx['demo-organization'];
  const locA = rooms[0].id;
  const locB = rooms[1].id;
  const sup = supervisors[0].id;

  const tickets = [
    await createTestTicket(org.id, locA, { title: 'Flickering light in Ward 1', status: 'OPEN', priority: 'HIGH' }),
    await createTestTicket(org.id, locA, { title: 'Broken socket near bed 3', status: 'ASSIGNED', assignedToId: sup, priority: 'NORMAL' }),
    await createTestTicket(org.id, locB, { title: 'Ceiling fan not working', status: 'IN_PROGRESS', assignedToId: sup, priority: 'NORMAL' }),
    await createTestTicket(org.id, locB, { title: 'AC servicing overdue', status: 'ON_HOLD', priority: 'LOW' }),
    await createTestTicket(org.id, locA, { title: 'Corridor tube replaced', status: 'RESOLVED', priority: 'NORMAL', resolvedAt: new Date(), resolvedNote: 'Replaced tube light' }),
    await createTestTicket(org.id, locA, { title: 'Old fault (archived)', status: 'CLOSED', priority: 'LOW', resolvedAt: new Date() }),
    await createTestTicket(org.id, locB, { title: 'Public: corridor light out', status: 'OPEN', source: 'PUBLIC', priority: 'NORMAL', guestName: 'Visitor', issueType: 'LIGHT_NOT_WORKING' })
  ];

  return { tickets, count: tickets.length };
}

module.exports = {
  name: 'ticket-workflow',
  description: 'Tickets across the lifecycle (open → assigned → in-progress → resolved → closed) + a public complaint.',
  dependsOn: ['demo-organization'],
  apply
};
