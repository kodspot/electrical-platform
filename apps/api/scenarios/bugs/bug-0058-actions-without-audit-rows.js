'use strict';

/**
 * BUG-0058 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');
// [route file, the audit actions it must write]
const REQUIRED = [
  ['auth.js', ['signed_in', 'password_changed', 'password_reset']],
  ['worker-auth.js', ['signed_in', 'pin_changed', 'pin_reset']],
  ['templates.js', ['template_created', 'template_updated', 'template_deactivated', 'template_deleted', 'template_duplicated']],
  ['duty-roster.js', ['roster_created', 'roster_location_changed', 'roster_workers_changed', 'roster_deleted']],
  ['attendance.js', ['attendance_marked', 'attendance_updated']],
  ['alerts.js', ['alert_rule_created', 'alert_rule_updated', 'alert_rule_deleted', 'alert_acknowledged', 'alerts_acknowledged', 'alert_checks_run', 'alert_escalations_run']],
  ['tickets.js', ['ticket_created']]
];

module.exports = {
  id: 'BUG-0058',
  title: 'Sign-ins, password and PIN changes, templates, rosters, attendance edits, alert actions and ticket creation left no audit row',
  description: 'The audit log, which admins read to see who changed what, had no row for: signing in; changing or resetting a password or PIN; creating, editing, duplicating or deleting an inspection template; starting, changing or removing a duty roster; editing an attendance record; editing an alert rule; acknowledging one or all alerts; running the alert checks by hand; and raising a ticket as staff. Found by the 2026-10 product and architecture review (PAR-10/13).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/13)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-26',
  rootCause: 'Each route wrote its own audit rows, and these never did.',
  expectedBehavior: 'Each of these writes one AuditLog row naming the actor (services/audit.js). Failed sign-ins are not audited, by decision.',
  brokenBehavior: 'No record of who signed in, changed a template, edited attendance, or acknowledged an alert.',
  reproductionSteps: [
    'As an admin, edit an inspection template; open the audit log.',
    'Broken: nothing. Fixed: "Template Updated" by that admin.',
    'Regression: test/integration/audit-coverage.test.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/audit-coverage.test.js',

  async apply() {
    return {};
  },

  async validate() {
    for (const [file, actions] of REQUIRED) {
      const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
      const missing = actions.filter((a) => !src.includes(`action: '${a}'`));
      if (missing.length) return { ok: false, detail: `${file} writes no ${missing.join(', ')} audit row` };
    }
    return { ok: true, detail: 'each of these actions writes an audit row' };
  }
};
