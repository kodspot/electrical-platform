'use strict';

/**
 * BUG-0043 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', '..', 'public', 'admin-alerts.html');
const API = path.join(__dirname, '..', '..', 'src', 'routes', 'alerts.js');

module.exports = {
  id: 'BUG-0043',
  title: 'Editing an alert rule silently dropped its "notify the location\'s supervisors / electricians" actions',
  description: 'The alert-rule form offered only Notify Admins, Notify Supervisors and Create Ticket, but the API accepts NOTIFY_ASSIGNED_SUPERVISORS and NOTIFY_ASSIGNED_WORKERS (what BUG-0019 made escalations reach). On edit the form rebuilt the actions from its checkboxes, so saving any change — even the description — removed those two actions from the rule and its escalation. The rule list showed them as raw codes. Found by the 2026-10 product and architecture review (PAR-10/51).',
  module: 'ele',
  category: 'admin-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/51)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The form had no checkbox for two action types the API validates, and saved only what it had checkboxes for.',
  expectedBehavior: 'Every action type the API accepts has a checkbox in both action lists, is loaded on edit and saved back; the list labels them.',
  brokenBehavior: 'After an edit the rule had only NOTIFY_ADMINS; the escalation action was gone.',
  reproductionSteps: [
    'Create a rule (API) with NOTIFY_ASSIGNED_SUPERVISORS and an escalation NOTIFY_ASSIGNED_WORKERS.',
    'In admin-alerts, Edit the rule, change its description, save.',
    'Broken: both actions are gone. Fixed: kept. Browser test: e2e/tests/forms.spec.js (BUG-0043).'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js',

  async apply() {
    return {};
  },

  async validate() {
    const api = fs.readFileSync(API, 'utf8');
    const types = JSON.parse(((api.match(/const VALID_ACTIONS = (\[[^\]]*\])/) || [])[1] || '[]').replace(/'/g, '"'));
    if (!types.length) return { ok: false, detail: 'alerts.js VALID_ACTIONS not found' };
    const page = fs.readFileSync(PAGE, 'utf8');
    const saved = (block) => new Set([...block.matchAll(/push\(\{type:'([A-Z_]+)'/g)].map((m) => m[1]));
    const save = page.slice(page.indexOf("var actions = [];"), page.indexOf("var conditions = {};"));
    const esc = page.slice(page.indexOf('var escActions = [];'), page.indexOf('body.escalationActions'));
    for (const t of types) {
      if (!saved(save).has(t)) return { ok: false, detail: `the form cannot save the ${t} action` };
      if (t !== 'CREATE_TICKET' && !saved(esc).has(t)) return { ok: false, detail: `the form cannot save the ${t} escalation action` };
      if (!page.includes(`indexOf('${t}')`)) return { ok: false, detail: `the form does not load the ${t} action on edit` };
    }
    return { ok: true, detail: 'every action the API accepts is loaded and saved by the form' };
  }
};
