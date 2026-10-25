'use strict';

/**
 * BUG-0033 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

module.exports = {
  id: 'BUG-0033',
  title: 'A proof photo uploaded late in an old ticket\'s life was deleted the next night',
  description: 'The daily image cleanup keeps photos for 30 days, but it counted a ticket\'s proof photo (resolvedImageUrl) from the TICKET\'s creation. When work on a ticket older than 30 days was finished, its new proof photo was deleted at the next cleanup — before the supervisor verified it or the resident saw it. Found by the 2026-10 product and architecture review (PAR-10/18).',
  module: 'ele',
  category: 'ticket-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/18)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'cleanupExpiredImages selected tickets by createdAt < cutoff and removed both photos.',
  expectedBehavior: 'Each photo is kept for 30 days from when it was taken: the complaint photo from the ticket\'s creation, the proof photo from resolvedAt.',
  brokenBehavior: 'A proof photo resolved 2 days ago on a 40-day-old ticket was deleted.',
  reproductionSteps: [
    'Create a ticket 40 days ago that was resolved 2 days ago with a proof photo.',
    'Run the image cleanup (services/cleanup.js cleanupExpiredImages).',
    'Broken: resolvedImageUrl is null. Fixed: it is kept. Full test with real files and the real query: test/integration/image-cleanup.test.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/image-cleanup.test.js',

  async apply() {
    return {};
  },

  // The retention rule itself, without running the cleanup: a run here would sweep every
  // org's old photos in the shared test database.
  async validate() {
    const { expiredTicketPhotos } = require('../../src/services/cleanup');
    if (typeof expiredTicketPhotos !== 'function') return { ok: false, detail: 'the cleanup has no per-photo retention rule' };
    const cutoff = daysAgo(30);
    const lateFix = { createdAt: daysAgo(40), imageUrl: '/images/uploads/o/a.png', resolvedAt: daysAgo(2), resolvedImageUrl: '/images/uploads/o/b.png' };
    const fields = expiredTicketPhotos(lateFix, cutoff);
    if (fields.includes('resolvedImageUrl')) return { ok: false, detail: 'the 2-day-old proof photo of a 40-day-old ticket would be removed' };
    if (!fields.includes('imageUrl')) return { ok: false, detail: 'the 40-day-old complaint photo would be kept' };
    return { ok: true, detail: 'each photo is kept until 30 days after it was taken' };
  }
};
