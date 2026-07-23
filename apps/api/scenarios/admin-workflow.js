'use strict';

/**
 * Scenario: Admin Workflow. [platform-M3, DPS §4]
 * The admin management surface: an alert rule configured, and an audit-log entry so the
 * audit view is non-empty.
 */

const { createTestAlertRule, createTestAuditLog } = require('./factories');

async function apply(ctx) {
  const { org, admin } = ctx['demo-organization'];

  const rule = await createTestAlertRule(org.id, {
    name: 'Missed inspection alert',
    trigger: 'INSPECTION_MISSED',
    conditions: {},
    actions: [{ type: 'NOTIFY_ADMINS' }]
  });

  const audit = await createTestAuditLog(org.id, {
    actorType: 'admin',
    actorId: admin.id,
    action: 'alert_rule_created',
    entityType: 'AlertRule',
    entityId: rule.id
  });

  return { rule, audit };
}

module.exports = {
  name: 'admin-workflow',
  description: 'Admin management state: an alert rule + an audit-log entry.',
  dependsOn: ['demo-organization'],
  apply
};
