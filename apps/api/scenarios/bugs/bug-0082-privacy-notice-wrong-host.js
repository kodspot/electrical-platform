'use strict';

/**
 * BUG-0082 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0082',
  title: 'The privacy notice named the wrong hosting provider',
  description: 'The notice said data was held on Google Cloud in Mumbai. Production runs on AWS EC2 (deploy.yml). The region was not confirmed, so the notice no longer states one: AUD-11/14.',
  module: 'ele',
  category: 'privacy',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'The notice was written for an earlier host and not updated when the host changed.',
  expectedBehavior: 'The notice names the providers the deployment really uses.',
  brokenBehavior: 'The notice named a provider that does not hold the data.',
  reproductionSteps: [
    'Read section 4 of /privacy.',
    'Compare it with the AWS_HOST secret in deploy.yml.',
    'Broken: Google Cloud. Fixed: Amazon Web Services.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0082-privacy-notice-wrong-host.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('../../.github/workflows/deploy.yml').includes('AWS_HOST')) return { ok: false, detail: 'the deploy target changed: check the notice' };
    if (read('public/privacy.html').includes('Google Cloud Platform')) return { ok: false, detail: 'the notice names Google Cloud as the host' };
    if (!read('public/privacy.html').includes('Amazon Web Services</strong>')) return { ok: false, detail: 'the notice does not name the host' };
    return { ok: true, detail: 'the notice names the real host' };
  }
};
