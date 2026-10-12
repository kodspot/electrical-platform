'use strict';

/**
 * Test-process safety preload (QA-1). scripts/run-tests.js loads this with
 * `node --require` into every test-file process, so it runs before src/config/env.js
 * can let dotenv inject the repo-root .env. dotenv never overrides a key that is
 * already set — even to '' — so blanking a key here keeps the real value out.
 *
 * Fails closed: on an unsafe database target the process exits 1 before any test runs.
 * Never prints a value read from the environment or a .env file.
 */

const {
  evaluateTarget, readRootEnvText, OUTBOUND_BLANKED, R2_PLACEHOLDERS, R2_PLACEHOLDER_VALUE
} = require('./safety-rules');

function applySafety() {
  for (const key of OUTBOUND_BLANKED) process.env[key] = '';
  for (const key of R2_PLACEHOLDERS) process.env[key] = R2_PLACEHOLDER_VALUE;

  const hasAmbientUrl = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
  const verdict = evaluateTarget({ env: process.env, dotenvText: hasAmbientUrl ? null : readRootEnvText() });
  if (!verdict.ok) {
    process.stderr.write(`\n[test safety] ${verdict.code}: ${verdict.message}\n\n`);
    process.exit(1);
  }
  globalThis.__qaSafetyPreload = process.pid;
}

// `node --test` discovery also executes every file under test/ as a test file. Only act
// when preloaded (require.main is not yet set during --require), never as a main module.
if (require.main !== module) applySafety();
