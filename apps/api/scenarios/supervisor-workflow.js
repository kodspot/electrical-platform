'use strict';

/**
 * Scenario: Supervisor Workflow. [platform-M3, DPS §4]
 * Puts a supervisor in a realistic working state: a ticket awaiting their verification
 * (a worker resolved it, pending sign-off).
 */

const { createTestTicket } = require('./factories');

async function apply(ctx) {
  const { org, rooms, supervisors } = ctx['demo-organization'];

  const pendingVerify = await createTestTicket(org.id, rooms[0].id, {
    title: 'Emergency light — awaiting your verification',
    status: 'RESOLVED_PENDING_VERIFY',
    assignedToId: supervisors[0].id,
    priority: 'HIGH',
    resolvedNote: 'Replaced emergency light battery',
    resolvedImageUrl: '/images/uploads/demo/placeholder.webp'
  });

  return { pendingVerify };
}

module.exports = {
  name: 'supervisor-workflow',
  description: 'A ticket in RESOLVED_PENDING_VERIFY assigned to a supervisor (awaiting verification).',
  dependsOn: ['demo-organization'],
  apply
};
