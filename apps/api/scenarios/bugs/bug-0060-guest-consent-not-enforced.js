'use strict';

/**
 * BUG-0060 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestLocation } = require('../factories');

module.exports = {
  id: 'BUG-0060',
  title: 'A guest\'s name and phone were accepted without their consent; consent was never recorded',
  description: 'The privacy policy says a guest giving a name or phone must check a consent box. Only scan.html checked it and it never sent it, so POST /api/public/complaint accepted contact details without consent from any other client, and no record showed that consent was given. Found by the 2026-10 product and architecture review (PAR-10/48).',
  module: 'complaints',
  category: 'public-complaint',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/48)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-26',
  rootCause: 'Consent was a browser-only check.',
  expectedBehavior: 'Contact details without consent: 400. With it: accepted, and the complaint\'s audit row records consent: true.',
  brokenBehavior: 'POST with guestName and no consent → 200; nothing recorded.',
  reproductionSteps: [
    'POST /api/public/complaint with guestName and no consent.',
    'Broken: 200. Fixed: 400 "Please check the consent box…".',
    'Regression: test/integration/public-complaint-consent.test.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/public-complaint-consent.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    return { org, location };
  },

  async validate(ctx) {
    const { location } = ctx['BUG-0060'];
    const res = await ctx.app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': '10.88.60.250' }, payload: { locationId: location.id, issueType: 'LIGHT_NOT_WORKING', guestName: 'No Consent' } });
    if (res.statusCode !== 400) return { ok: false, detail: `contact details without consent answered ${res.statusCode}` };
    if (await ctx.prisma.ticket.count({ where: { locationId: location.id } })) return { ok: false, detail: 'a ticket was made anyway' };
    return { ok: true, detail: 'contact details need consent' };
  }
};
