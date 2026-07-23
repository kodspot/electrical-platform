'use strict';

/**
 * BUG-0003 — a fixed defect, encoded as a reproducible scenario + regression. [platform-M4]
 */

const { createTestOrg, createTestLocation } = require('../factories');

module.exports = {
  id: 'BUG-0003',
  title: 'Public-complaint spam risk score was computed but never enforced',
  description: 'The abuse risk score on public complaints was recorded on the ticket but never acted on, so a spammer could file unlimited near-duplicate complaints.',
  module: 'complaints',
  category: 'public-complaint',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Public Complaint Abuse Prevention ([WP11], audit finding H8)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-07-21',
  rootCause: 'POST /public/complaint computed a duplicate-submission riskScore and stored it, but no code rejected high-risk submissions.',
  expectedBehavior: 'A 4th rapid complaint from the same IP for the same location (risk score at its top tier) is rejected with 429.',
  brokenBehavior: 'Every submission succeeded (200) regardless of the risk score.',
  reproductionSteps: [
    'Create an org with a location.',
    'Submit 3 public complaints from the same IP for the same location (all 200).',
    'Submit a 4th from the same IP+location.',
    'Broken: 200. Fixed: 429 (rejected).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/bug-regressions.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    // A fresh random IP each run so the risk/rate-limit state never accumulates across runs.
    const ip = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    return { org, locationId: location.id, ip };
  },

  async validate(ctx) {
    const { locationId, ip } = ctx['BUG-0003'];
    const submit = () => ctx.app.inject({
      method: 'POST', url: '/api/public/complaint',
      headers: { 'x-forwarded-for': ip },
      payload: { locationId, issueType: 'LIGHT_NOT_WORKING' }
    });
    for (let i = 0; i < 3; i++) {
      const r = await submit();
      if (r.statusCode !== 200) return { ok: false, detail: `submission ${i + 1} expected 200, got ${r.statusCode}` };
    }
    const blocked = await submit();
    if (blocked.statusCode !== 429) return { ok: false, detail: `4th rapid complaint expected 429, got ${blocked.statusCode}` };
    return { ok: true, detail: '4th rapid same-IP+location complaint correctly rejected (429)' };
  }
};
