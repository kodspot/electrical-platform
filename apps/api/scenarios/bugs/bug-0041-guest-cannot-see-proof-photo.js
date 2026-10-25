'use strict';

/**
 * BUG-0041 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const crypto = require('node:crypto');
const { createTestOrg, createTestLocation, createTestTicket } = require('../factories');

module.exports = {
  id: 'BUG-0041',
  title: 'The guest review page asked the resident to confirm a fix but could not show its proof photo',
  description: 'GET /api/public/review/:token returned the proof photo\'s raw /images/... path, and review.html used it as the image source. Photos are served only through /api/images/... with a staff or electrician token; the guest has neither, so the photo they were asked to judge never loaded. Found by the 2026-10 product and architecture review (PAR-10/23).',
  module: 'complaints',
  category: 'public-complaint',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/23)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The review flow had no way to serve the photo to a holder of the review link.',
  expectedBehavior: 'The review response gives photoUrl = /api/public/review/:token/photo (not the storage path); that route serves only this ticket\'s proof photo while its review is open, and 404 otherwise.',
  brokenBehavior: 'The review page showed a broken image.',
  reproductionSteps: [
    'Resolve a public ticket with a proof photo so a guest review link is issued.',
    'Open /review/:token as the guest.',
    'Broken: a broken image. Fixed: the photo shows. Browser test: e2e/tests/journeys.spec.js J5; API test: ticket-resolve-verify.test.js (BUG-0041).'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/ticket-resolve-verify.test.js',

  async apply() {
    const org = await createTestOrg();
    const location = await createTestLocation(org.id);
    const token = crypto.randomBytes(32).toString('hex');
    await createTestTicket(org.id, location.id, {
      source: 'PUBLIC', status: 'RESOLVED', resolvedAt: new Date(), resolvedImageUrl: `/images/uploads/${org.id}/bug-0041.png`,
      reviewToken: token, reviewStatus: 'PENDING', reviewExpiresAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    return { org, token };
  },

  async validate(ctx) {
    const { token } = ctx['BUG-0041'];
    const res = await ctx.app.inject({ method: 'GET', url: `/api/public/review/${token}`, headers: { 'x-forwarded-for': '10.94.0.41' } });
    if (res.statusCode !== 200) return { ok: false, detail: `review GET answered ${res.statusCode}` };
    const t = res.json().ticket || {};
    if ('resolvedImageUrl' in t) return { ok: false, detail: 'the review response still hands the guest the storage path' };
    if (t.photoUrl !== `/api/public/review/${token}/photo`) return { ok: false, detail: `photoUrl is ${t.photoUrl}` };
    const wrong = await ctx.app.inject({ method: 'GET', url: `/api/public/review/${'f'.repeat(64)}/photo`, headers: { 'x-forwarded-for': '10.94.0.41' } });
    if (wrong.statusCode !== 404) return { ok: false, detail: `an unknown review token answered ${wrong.statusCode}` };
    return { ok: true, detail: 'the review link carries its own proof photo URL' };
  }
};
