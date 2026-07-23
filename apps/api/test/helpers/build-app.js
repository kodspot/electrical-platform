'use strict';

// Must be set before index.js (and its require of src/config/env.js) loads.
// dotenv only fills in variables that aren't already set, so these win over
// whatever the real .env file has. Tests are always run as non-production and
// never depend on the real .env having a valid DATA_ENCRYPTION_KEY — that
// validation is unconditional (see src/config/env.js), so a hermetic dummy value
// is supplied here instead, matching the pattern already used in
// test/lib-crypto.test.js.
process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { buildApp, registerApp } = require('../../index');

/**
 * Builds and registers a fully-wired app instance for use with fastify.inject().
 * Does not connect to the database, seed the module registry, or listen on a port.
 * Memoized: the same instance is reused across every test that calls this within a
 * single test-runner process, matching production's single-Prisma-client-singleton
 * design and avoiding the cost of re-registering ~25 route files per test file.
 */
let appPromise = null;

function getTestApp() {
  if (!appPromise) {
    const fastify = buildApp({ logger: false });
    appPromise = registerApp(fastify).then(() => fastify);
  }
  return appPromise;
}

module.exports = { getTestApp };
