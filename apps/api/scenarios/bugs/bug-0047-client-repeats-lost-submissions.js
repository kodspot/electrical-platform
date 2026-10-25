'use strict';

/**
 * BUG-0047 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');

module.exports = {
  id: 'BUG-0047',
  title: 'The pages re-sent a submission after a network error, so one tap could create two complaints or tickets',
  description: 'public/js/app.js _doFetch retried every request up to three times when fetch failed with a network error — POST, PATCH and DELETE included. On a weak campus or mobile connection the request can reach the server and only the response be lost; the retry then submitted the same complaint, ticket, inspection or edit again. Found by the 2026-10 product and architecture review (PAR-10/54).',
  module: 'ele',
  category: 'resilience',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/54)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The retry loop did not distinguish idempotent requests from submissions.',
  expectedBehavior: 'Only GET/HEAD are retried after a network error; a submission fails once with the "Network error" message. A 503 (the circuit breaker refused before doing any work) is still retried.',
  brokenBehavior: 'A POST whose first attempt failed on the network was sent again.',
  reproductionSteps: [
    'Load app.js with a fetch that fails once with a network error, then answers.',
    'App.apiFetch(path, { method: "POST" }).',
    'Broken: two POSTs reach fetch. Fixed: one, and the call rejects.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/public-escaping.test.js',

  async apply() {
    return {};
  },

  async validate() {
    const noop = () => {};
    const calls = [];
    const sandbox = {
      window: { addEventListener: noop }, navigator: {}, location: { pathname: '/', href: '' },
      localStorage: { getItem: () => 'tkn', setItem: noop, removeItem: noop },
      document: {
        addEventListener: noop, querySelector: () => null, getElementById: () => null, body: { appendChild: noop },
        createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, remove: noop, addEventListener: noop, innerHTML: '', textContent: '' })
      },
      setTimeout: (fn) => { fn(); return 0; }, clearTimeout: noop, FormData: class FormData {},
      fetch: async (url, opts) => {
        calls.push((opts && opts.method) || 'GET');
        if (calls.length === 1) throw new TypeError('Failed to fetch');
        return { status: 200, ok: true, json: async () => ({}) };
      }
    };
    vm.runInNewContext(fs.readFileSync(APP_JS, 'utf8'), sandbox);
    try { await sandbox.window.App.apiFetch('/tickets', { method: 'POST', body: '{}' }); } catch { /* expected */ }
    if (calls.length !== 1) return { ok: false, detail: `a POST that failed on the network was sent ${calls.length} times` };
    return { ok: true, detail: 'a failed submission is not re-sent' };
  }
};
