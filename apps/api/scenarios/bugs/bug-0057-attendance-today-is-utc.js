'use strict';

/**
 * BUG-0057 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes');

module.exports = {
  id: 'BUG-0057',
  title: 'Supervisors could mark attendance for any future date, and for two days back just after midnight',
  description: 'POST /attendance/bulk and POST /duty-roster allowed supervisors "today or yesterday" with "today" taken as the UTC date — until 05:30 in India still the day before, so the day before yesterday was accepted — and the attendance check had no upper bound, so any future date passed. The dashboard\'s GET /attendance/today showed yesterday\'s attendance until 05:30. Found while fixing BUG-0055 (PAR-10/07).',
  module: 'ele',
  category: 'supervisor-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Found while fixing BUG-0055 (PAR-10/07), 2026-10-26',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-26',
  rootCause: 'today.setUTCHours(0, 0, 0, 0) is the UTC date; only a lower bound was checked.',
  expectedBehavior: 'Supervisors mark attendance for the local today or yesterday only (admins override); rosters from the local yesterday; the dashboard shows the local today.',
  brokenBehavior: 'Attendance for tomorrow accepted; at 01:00 IST the day before yesterday accepted and yesterday shown as today.',
  reproductionSteps: [
    'As a supervisor, POST /api/attendance/bulk for tomorrow.',
    'Broken: 200. Fixed: 400 "Supervisors can only mark attendance for today or yesterday".',
    'Regression: test/integration/attendance-local-day.test.js (Asia/Kolkata, clock at 01:00).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/attendance-local-day.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const attendance = fs.readFileSync(path.join(ROUTES, 'attendance.js'), 'utf8');
    const roster = fs.readFileSync(path.join(ROUTES, 'duty-roster.js'), 'utf8');
    if (/setUTCHours\(0, 0, 0, 0\)/.test(attendance + roster)) return { ok: false, detail: '"today" is still taken as the UTC date' };
    if (!attendance.includes('data.date < yesterday || data.date > today')) return { ok: false, detail: 'attendance has no upper bound' };
    if (!roster.includes('data.date < yesterday')) return { ok: false, detail: 'the roster check is gone (update this scenario)' };
    return { ok: true, detail: 'today and yesterday are local dates; no future attendance' };
  }
};
