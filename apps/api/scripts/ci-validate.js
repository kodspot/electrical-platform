'use strict';

/**
 * Repository health & safety validation. [platform-M5, DPS §7 / blueprint M5]
 *
 * The DB-free, secret-free half of the CI gate: repository structure, package integrity,
 * environment documentation, migration safety, and generated-file (documentation) drift.
 * The heavy gates — lint, the full test suite (which already includes the scenario
 * platform and the bug regression library), and the route-index drift check — are run by
 * `npm run ci` around this script; this file adds the checks that don't exist elsewhere.
 * Reuses existing generators/scripts; duplicates none of them.
 *
 *   node scripts/ci-validate.js            — all checks (used by `npm run ci`)
 *   node scripts/ci-validate.js --release  — deployment-readiness subset (used by release:check)
 *
 * Exits non-zero on the first category that fails so CI stops immediately.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { API_DIR, ROOT_DIR, NPX, SHELL_SPAWN, loadRootEnv } = require('./_platform');

let failures = 0;
const pass = (name, detail) => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail) => { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
const rootRel = (...p) => path.join(ROOT_DIR, ...p);
const apiRel = (...p) => path.join(API_DIR, ...p);

// ── Repository structure ──
function checkStructure() {
  const required = [
    'package.json', '.env.example', 'docker-compose.yml',
    'apps/api/package.json', 'apps/api/src', 'apps/api/prisma/schema.prisma',
    'apps/api/prisma/migrations', 'apps/api/test',
    'apps/api/scenarios', 'apps/api/scenarios/factories.js', 'apps/api/scenarios/bugs',
    'docs', 'docs/architecture', 'docs/adr', 'docs/reference', 'docs/ENGINEERING_CHARTER.md'
  ];
  const missing = required.filter((p) => !fs.existsSync(rootRel(p)));
  if (missing.length) fail('repository structure', `missing: ${missing.join(', ')}`);
  else pass('repository structure', `${required.length} required paths present`);
}

// ── Package integrity ──
function checkPackage() {
  let ok = true;
  let root, api;
  try { root = JSON.parse(fs.readFileSync(rootRel('package.json'), 'utf8')); }
  catch (e) { fail('package integrity', `root package.json: ${e.message}`); return; }
  try { api = JSON.parse(fs.readFileSync(apiRel('package.json'), 'utf8')); }
  catch (e) { fail('package integrity', `apps/api/package.json: ${e.message}`); return; }

  const rootScripts = ['setup', 'dev', 'doctor', 'verify', 'clean', 'reset', 'seed', 'scenario', 'demo', 'bug:list', 'bug:validate', 'ci', 'release:check'];
  const apiScripts = ['start', 'test', 'lint', 'ci', 'db:deploy'];
  const missRoot = rootScripts.filter((s) => !root.scripts || !root.scripts[s]);
  const missApi = apiScripts.filter((s) => !api.scripts || !api.scripts[s]);
  if (missRoot.length) { ok = false; fail('package scripts (root)', `missing: ${missRoot.join(', ')}`); }
  if (missApi.length) { ok = false; fail('package scripts (apps/api)', `missing: ${missApi.join(', ')}`); }
  if (!fs.existsSync(apiRel('package-lock.json'))) { ok = false; fail('package lockfile', 'apps/api/package-lock.json missing'); }
  if (ok) pass('package integrity', 'both manifests valid, required scripts present, lockfile present');
}

// ── Environment documentation ──
function checkEnv() {
  const envSrc = fs.readFileSync(apiRel('src/config/env.js'), 'utf8');
  // Every env var config/env.js hard-requires (double-quoted UPPER_SNAKE), plus the
  // unconditionally-validated DATA_ENCRYPTION_KEY (accessed unquoted).
  const required = new Set([...envSrc.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]));
  required.add('DATA_ENCRYPTION_KEY');
  const example = fs.readFileSync(rootRel('.env.example'), 'utf8');
  const documented = (v) => new RegExp(`^\\s*#?\\s*${v}=`, 'm').test(example);
  const undoc = [...required].filter((v) => !documented(v));
  if (undoc.length) fail('environment documentation', `.env.example is missing: ${undoc.join(', ')}`);
  else pass('environment documentation', `${required.size} required vars documented in .env.example`);
}

// ── Migration safety (DB-free) ──
function checkMigrations() {
  try {
    // `prisma validate` resolves the datasource's env("DATABASE_URL") even though it
    // never connects, so the var must merely be *set*. Source it the same way the other
    // dev commands do — ambient env first (CI sets it job-level), then the repo-root
    // .env (a developer's normal setup) — falling back to a clearly non-connecting
    // placeholder so this schema-validity check stays runnable with no DB configured at all.
    const dbUrl = process.env.DATABASE_URL || loadRootEnv().DATABASE_URL
      || 'postgresql://schema-validation-only@localhost:5432/unused';
    execFileSync(NPX, ['prisma', 'validate', '--schema', 'prisma/schema.prisma'], {
      cwd: API_DIR, stdio: 'pipe', env: { ...process.env, DATABASE_URL: dbUrl }, ...SHELL_SPAWN
    });
  } catch (e) {
    return fail('migration safety', `prisma schema is invalid: ${`${e.stderr || e.message}`.slice(0, 200)}`);
  }
  const migDir = apiRel('prisma/migrations');
  const migrations = fs.readdirSync(migDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (migrations.length === 0) return fail('migration safety', 'no migrations found');
  const brokenMig = migrations.filter((d) => !fs.existsSync(path.join(migDir, d.name, 'migration.sql')));
  if (brokenMig.length) return fail('migration safety', `migrations missing migration.sql: ${brokenMig.map((d) => d.name).join(', ')}`);
  pass('migration safety', `schema valid, ${migrations.length} migrations each with migration.sql`);
}

// ── Generated documentation drift ──
function checkGenerated() {
  // Route index — reuse the existing M2 drift check (regenerates + content-compares).
  try {
    execFileSync('node', ['scripts/check-routes-drift.js'], { cwd: API_DIR, stdio: 'pipe' });
    pass('generated: route index', 'up to date');
  } catch (e) {
    fail('generated: route index', `${e.stdout || e.stderr || 'stale — run npm run docs:routes'}`.toString().trim().slice(0, 160));
  }
  // Bug registry — regenerate and compare (line-ending tolerant).
  const bugDoc = rootRel('docs/reference/bug-registry.generated.md');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const before = fs.existsSync(bugDoc) ? fs.readFileSync(bugDoc, 'utf8') : '';
  try {
    execFileSync('node', ['scripts/gen-bug-registry.js'], { cwd: API_DIR, stdio: 'pipe' });
    const after = fs.readFileSync(bugDoc, 'utf8');
    if (norm(before) !== norm(after)) fail('generated: bug registry', 'stale — run npm run docs:bugs and commit');
    else pass('generated: bug registry', 'up to date');
  } catch (e) {
    fail('generated: bug registry', `generator failed: ${`${e.stderr || e.message}`.slice(0, 160)}`);
  }
}

const release = process.argv.includes('--release');
console.log(`\nRepository validation${release ? ' — release readiness' : ''}\n`);

checkStructure();
checkPackage();
checkEnv();
checkMigrations();
checkGenerated();

console.log('');
if (failures) { console.error(`ci-validate: ${failures} check category(ies) FAILED.`); process.exit(1); }
console.log('ci-validate: all checks passed.');
process.exit(0);
