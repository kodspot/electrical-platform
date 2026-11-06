'use strict';

/**
 * BUG-0077 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0077',
  title: 'An image that could not be re-encoded was stored as it came, metadata included',
  description: 'lib/r2.js fell back to the original bytes when sharp failed. Re-encoding is what removes EXIF, so a photo cut short in transit kept the location it was taken at. AUD-11/13.',
  module: 'ele',
  category: 'privacy',
  severity: 'LOW',
  status: 'FIXED',
  origin: 'Audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-07',
  rootCause: 'The failure path favoured keeping the upload.',
  expectedBehavior: 'A cut-short photo is recovered and re-encoded; one that cannot be read is refused.',
  brokenBehavior: 'The original was stored unchanged.',
  reproductionSteps: [
    'Upload a JPEG with EXIF, cut short.',
    'Read the stored object.',
    'Broken: it is the original JPEG. Fixed: a WebP with no EXIF.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/test/lib-storage.test.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('src/lib/r2.js').includes(`failOn: 'none'`)) return { ok: false, detail: 'truncated photos are not recovered' };
    if (!read('src/lib/r2.js').includes('refused.statusCode = 400')) return { ok: false, detail: 'an unreadable image is not refused' };
    return { ok: true, detail: 'unreadable images are refused' };
  }
};
