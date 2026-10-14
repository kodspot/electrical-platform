'use strict';

/**
 * `npm run doctor` — read-only environment preflight. [platform-M2, DPS §2]
 *
 * Verifies a developer's local setup is ready before `dev`, with actionable
 * messages. Mutates NOTHING. Exits non-zero if any critical check fails.
 * Never prints secret values — only lengths, hosts, and pass/fail.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { API_DIR, ROOT_ENV, NPX, SHELL_SPAWN, loadRootEnv, dbHostSafe, isLocalDb } = require('./_platform');

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m, fix) => { failures++; console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`); };

console.log('\nDeveloper environment preflight (doctor)\n');

// 1. Node version
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major >= 20) ok(`Node ${process.versions.node} (>= 20)`);
else bad(`Node ${process.versions.node} is too old`, 'Install Node 20+');

// 2. Repo-root .env present
if (fs.existsSync(ROOT_ENV)) ok('.env present at repo root');
else bad('.env is missing', 'cp .env.dev.example .env');

const env = loadRootEnv();
const driver = (env.STORAGE_DRIVER || 'r2').toLowerCase();

// 3. Required env keys (length/format only — never the value)
const need = (key, pred, desc) => {
  const v = env[key] || '';
  if (v && pred(v)) ok(`${key} set (${desc})`);
  else bad(`${key} missing or invalid (${desc})`, 'See .env.dev.example / docs/reference/environment.md');
};
need('DATABASE_URL', (v) => v.startsWith('postgres'), 'postgres URL');
need('JWT_SECRET', (v) => v.length >= 32, '>= 32 chars');
need('COOKIE_SECRET', (v) => v.length >= 32, '>= 32 chars');
need('ADMIN_KEY', (v) => v.length >= 16, '>= 16 chars');
need('DATA_ENCRYPTION_KEY', (v) => /^[0-9a-fA-F]{64}$/.test(v), '64 hex chars');

// 4. Storage driver sanity
if (['r2', 'local'].includes(driver)) {
  ok(`STORAGE_DRIVER=${driver}`);
  if (driver === 'r2') {
    const haveR2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'].every((k) => env[k]);
    if (haveR2) ok('R2 credentials present (required for the r2 driver)');
    else bad('STORAGE_DRIVER=r2 but R2_* credentials are missing', 'Set STORAGE_DRIVER=local for local dev, or provide R2 creds');
  }
} else bad(`STORAGE_DRIVER="${driver}" is not r2 or local`, 'Use STORAGE_DRIVER=local for development');

// 5. Dependencies installed
if (fs.existsSync(path.join(API_DIR, 'node_modules'))) ok('apps/api/node_modules present');
else bad('dependencies not installed', 'npm run setup');

// 6. Database reachable + migrations applied (read-only; connects, does not mutate)
if (isLocalDb(env.DATABASE_URL || '') && /:5432\//.test(env.DATABASE_URL || '')) {
  // docker-compose.dev.yml moved to 5433 (5432 is the production compose's port).
  warn('DATABASE_URL uses port 5432, but the dev database (docker-compose.dev.yml) listens on 127.0.0.1:5433 — copy DATABASE_URL from .env.dev.example');
}
if (isLocalDb(env.DATABASE_URL || '')) {
  try {
    execFileSync(NPX, ['prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma'], {
      cwd: API_DIR, env: { ...process.env, ...env }, stdio: 'pipe', ...SHELL_SPAWN
    });
    ok(`database reachable at ${dbHostSafe(env.DATABASE_URL)} and migrations up to date`);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/not yet been applied|pending|following migration/i.test(out)) {
      bad('database reachable but migrations are pending', 'npm run setup (or: npm --prefix apps/api run db:deploy)');
    } else {
      bad(`database not reachable at ${dbHostSafe(env.DATABASE_URL)}`, 'docker compose -f docker-compose.dev.yml up -d   (Postgres on 127.0.0.1:5433)');
    }
  }
} else {
  warn(`DATABASE_URL host is ${dbHostSafe(env.DATABASE_URL || '')} (not localhost) — skipping DB check (not a local dev target)`);
}

console.log('');
if (failures === 0) { console.log('doctor: all checks passed — you are ready to `npm run dev`.\n'); process.exit(0); }
console.log(`doctor: ${failures} check(s) failed — fix the → items above, then re-run.\n`);
process.exit(1);
