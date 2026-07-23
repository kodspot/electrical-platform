'use strict';

/**
 * Scenario: Worker Workflow. [platform-M3, DPS §4]
 * Puts an electrician in a realistic working state: an open, unassigned ticket at a
 * location they cover, eligible to be picked up from the electrician app.
 */

const { createTestTicket } = require('./factories');

async function apply(ctx) {
  const { org, building } = ctx['demo-organization'];

  const pickupEligible = await createTestTicket(org.id, building.id, {
    title: 'Power socket sparking — needs pickup',
    status: 'OPEN',
    priority: 'URGENT'
  });

  return { pickupEligible };
}

module.exports = {
  name: 'worker-workflow',
  description: 'An open, unassigned URGENT ticket at a covered location, eligible for worker pickup.',
  dependsOn: ['demo-organization'],
  apply
};
