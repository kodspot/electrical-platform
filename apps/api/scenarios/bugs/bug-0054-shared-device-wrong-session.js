'use strict';

/**
 * BUG-0054 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

module.exports = {
  id: 'BUG-0054',
  title: 'On a shared phone, an inspection saved offline was sent in as whoever else was signed in',
  description: 'public/js/app.js replayed the offline queue, from any page that came back online, with the first token found (admin, super admin, supervisor, electrician — in that order). On a device where a supervisor and an admin were both signed in, a supervisor\'s inspection saved offline was submitted with the admin\'s session and recorded as the admin\'s. App.imgUrl put the first token found into photo URLs the same way. Found by the 2026-10 product and architecture review (PAR-10/49).',
  module: 'ele',
  category: 'supervisor-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/49)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The replay and imgUrl had no notion of which role a request belonged to.',
  expectedBehavior: 'A queued entry records its role and is replayed only with that role\'s token (it waits if that role is signed out); photo URLs carry the page\'s own session.',
  brokenBehavior: 'The inspection was recorded under the admin; it could also be sent with a session of another organization.',
  reproductionSteps: [
    'On one browser, sign in as an admin and as a supervisor.',
    'Go offline on supervisor-electrical, submit an inspection (it is saved), then come back online on an admin page.',
    'Broken: the inspection is submitted with the admin\'s token. Fixed: with the supervisor\'s. Test: test/shared-device-sessions.test.js.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/shared-device-sessions.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    if (app.includes('var token = getToken() || getSAToken() || getSupToken() || getElecToken();')) return { ok: false, detail: 'the offline replay takes the first token found' };
    if (!app.includes("var token = _scopeToken(entry.scope || 'supervisor');")) return { ok: false, detail: 'the offline replay does not use the queuing role\'s token' };
    if (!/var t = scope \? _scopeToken\(scope\)/.test(app)) return { ok: false, detail: 'imgUrl does not use the page\'s own session' };
    if (!/App\.enqueueRetry\(null, \{\s*scope: 'supervisor',/.test(fs.readFileSync(path.join(PUBLIC, 'supervisor-electrical.html'), 'utf8'))) return { ok: false, detail: 'the inspection page does not record its role with what it queues' };
    return { ok: true, detail: 'each request uses its own role\'s session' };
  }
};
