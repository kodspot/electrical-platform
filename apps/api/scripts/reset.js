'use strict';

/**
 * `npm run reset` — rebuild the local database from migrations, then seed. [platform-M3, DPS §2]
 *
 * Full form (completed in M3): drops the local database, re-applies all migrations, and
 * applies the canonical demo dataset — the fastest path back to a known, deterministic
 * state. Refuses to run against anything but a local database (production-safety contract).
 */

const { execFileSync } = require('child_process');
const { API_DIR, NPX, SHELL_SPAWN, loadRootEnv, assertLocalDevOnly, dbHostSafe } = require('./_platform');

const env = loadRootEnv();
assertLocalDevOnly(env);
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.DATABASE_URL = env.DATABASE_URL;

(async () => {
  console.log(`reset: rebuilding the local database at ${dbHostSafe(env.DATABASE_URL)} …`);

  // 1) Drop + re-apply migrations (non-interactive; skip Prisma's own seed hook — we seed below).
  execFileSync(NPX, ['prisma', 'migrate', 'reset', '--force', '--skip-seed', '--schema', 'prisma/schema.prisma'], {
    cwd: API_DIR, env: { ...process.env, ...env }, stdio: 'inherit', ...SHELL_SPAWN
  });

  // 2) Apply the demo dataset (in-process; the Prisma client reads the DATABASE_URL set above).
  console.log('\nreset: applying the demo dataset …');
  const { seed } = require('../scenarios');
  const { prisma } = require('../src/lib/prisma');
  await seed('demo');
  await prisma.$disconnect();

  console.log('\nreset: done — local database rebuilt from migrations and seeded with demo data.');
})().catch((e) => {
  console.error('\nreset: failed:', e.message);
  console.error('Is the local database running? (docker compose -f docker-compose.dev.yml up -d)');
  process.exit(1);
});
