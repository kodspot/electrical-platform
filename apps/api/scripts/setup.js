'use strict';

/**
 * `npm run setup` — one-command bootstrap after clone + configure. [platform-M2, DPS §2]
 *
 * Installs dependencies, applies migrations, and generates the Prisma client.
 * Idempotent: safe to re-run (e.g. after pulling new migrations). Does not seed —
 * `npm run seed` (a later milestone) does that.
 *
 * migrate deploy only APPLIES pending migrations (never drops), so this is safe to
 * run even against a shared database; it prints the target host (never the password).
 */

const { execFileSync } = require('child_process');
const { API_DIR, NPM, SHELL_SPAWN, loadRootEnv, dbHostSafe } = require('./_platform');

const env = loadRootEnv();
const childEnv = { ...process.env, ...env };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: API_DIR, env: childEnv, stdio: 'inherit', ...SHELL_SPAWN });

try {
  console.log('setup [1/3]: installing dependencies (npm ci) …');
  run(NPM, ['ci']);

  console.log(`\nsetup [2/3]: applying database migrations at ${dbHostSafe(env.DATABASE_URL)} …`);
  run(NPM, ['run', 'db:deploy']);

  console.log('\nsetup [3/3]: generating Prisma client …');
  run(NPM, ['run', 'db:generate']);

  console.log('\nsetup: complete. Next: `npm run dev` (and `npm run seed` once available).');
} catch {
  console.error('\nsetup: a step failed. Run `npm run doctor` to diagnose (is the local database up?).');
  process.exit(1);
}
