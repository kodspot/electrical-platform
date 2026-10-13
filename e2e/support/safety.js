'use strict';

/**
 * The e2e suite refuses to touch any database except a disposable loopback one whose name
 * ends in `_e2e`. It reuses the API test suite's rules (apps/api/test/setup/safety-rules.js —
 * imported, not copied) and narrows the accepted suffixes to `_e2e`. Messages never contain
 * the URL, host or database name.
 */

const { evaluateTarget } = require('../../apps/api/test/setup/safety-rules');

function assertE2eDatabase(env) {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('[e2e safety] DATABASE_URL is not set. Run the suite with `npm run e2e` from the repository root, which provides a disposable database.');
  }
  // CI=true would demand an ambient URL — it is ambient here — so judge it as a test run.
  const verdict = evaluateTarget({ env: { ...env, NODE_ENV: 'test' }, dotenvText: null });
  if (!verdict.ok) throw new Error(`[e2e safety] ${verdict.code}: ${verdict.message}`);
  let dbName = '';
  try { dbName = decodeURIComponent(new URL(url).pathname.slice(1)); } catch { /* covered above */ }
  if (!/_e2e$/.test(dbName)) {
    throw new Error('[e2e safety] The end-to-end suite only runs against a database whose name ends in _e2e.');
  }
}

module.exports = { assertE2eDatabase };
