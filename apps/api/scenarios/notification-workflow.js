'use strict';

/**
 * Scenario: Notification Workflow. [platform-M3, DPS §4]
 * Persisted notifications for each audience (admin, supervisor, worker).
 */

const { createTestNotification } = require('./factories');

async function apply(ctx) {
  const { org, admin, supervisors, workers } = ctx['demo-organization'];

  const notifications = [
    await createTestNotification(org.id, { userId: admin.id, type: 'ticket_created', title: 'New ticket created', body: 'Flickering light in Ward 1' }),
    await createTestNotification(org.id, { userId: supervisors[0].id, type: 'ticket_assigned', title: 'Ticket assigned to you', body: 'Broken socket near bed 3', isUrgent: true }),
    await createTestNotification(org.id, { workerId: workers[0].id, type: 'public_complaint', title: 'New complaint at your location', body: 'Corridor light out', isUrgent: true })
  ];

  return { notifications: notifications.length };
}

module.exports = {
  name: 'notification-workflow',
  description: 'Persisted notifications for an admin, a supervisor, and an electrician.',
  dependsOn: ['demo-organization'],
  apply
};
