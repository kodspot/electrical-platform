'use strict';

/**
 * BUG-0075 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0075',
  title: 'The privacy notice said photos are deleted after 7 days; they are kept 30',
  description: 'public/privacy.html stated 7 days while src/services/cleanup.js has RETENTION_DAYS = 30. A notice under DPDP s.5 must describe what is actually done.',
  module: 'ele',
  category: 'privacy',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Security and DPDP audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The retention period changed and the notice did not.',
  expectedBehavior: 'The notice states 30 days, and a check ties it to the constant.',
  brokenBehavior: 'Residents and staff were told their photos go after a week.',
  reproductionSteps: [
    'Read section 5 of /privacy.',
    'Compare RETENTION_DAYS in cleanup.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0075-privacy-notice-wrong-photo-retention.js',

  async apply() {
    return {};
  },

  async validate() {
    const days = Number(/RETENTION_DAYS = (\d+)/.exec(read('src/services/cleanup.js'))[1]);
    const notice = read('public/privacy.html');
    if (!notice.includes('deleted after <strong>' + days + ' days</strong>')) return { ok: false, detail: 'the notice does not state ' + days + ' days' };
    if (/deleted after (<strong>)?7 days/.test(notice)) return { ok: false, detail: 'the notice still says 7 days' };
    return { ok: true, detail: 'the notice matches the retention constant' };
  }
};
