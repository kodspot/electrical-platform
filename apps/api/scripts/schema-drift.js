'use strict';

/**
 * Schema-drift gate (F13). Called by scripts/ci-validate.js.
 *
 * Diffs the migrated database (DATABASE_URL — in CI, the database `prisma migrate deploy` just
 * built from prisma/migrations) against prisma/schema.prisma:
 *   prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script
 * and fails on any statement that is not in ALLOWLIST. After `migrate deploy` on a fresh
 * database this is exactly "migrations vs schema", so a schema edit without a migration (or a
 * migration the schema doesn't describe) fails CI instead of drifting silently.
 *
 * Without a reachable database the check is skipped with a notice — except under CI=true,
 * where a database is always provided and a skip would hide drift, so it fails.
 *
 *   node scripts/schema-drift.js            — run the check (exit 1 on drift)
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// ── ALLOWLIST — REMOVE AT PRISMA 6 UPGRADE ──
// Prisma 5 models an implicit many-to-many join table with a UNIQUE INDEX on ("A","B"); the
// migrations (and therefore the database) have a composite PRIMARY KEY instead. Prisma 6 uses a
// primary key again, so at the Prisma 6 upgrade these four statements disappear from the diff:
// delete this allowlist then (an allowed statement that no longer appears is reported as stale).
const ALLOWLIST = [
  'ALTER TABLE "_ElectricalInspectionToWorker" DROP CONSTRAINT "_ElectricalInspectionToWorker_AB_pkey"',
  'ALTER TABLE "_TicketResolvedWorkers" DROP CONSTRAINT "_TicketResolvedWorkers_AB_pkey"',
  'CREATE UNIQUE INDEX "_ElectricalInspectionToWorker_AB_unique" ON "_ElectricalInspectionToWorker"("A", "B")',
  'CREATE UNIQUE INDEX "_TicketResolvedWorkers_AB_unique" ON "_TicketResolvedWorkers"("A", "B")'
];

/** Split `migrate diff --script` output into normalized SQL statements (comments dropped). */
function statementsOf(sql) {
  return String(sql || '')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== 'This is an empty migration.');
}

/** Pure decision: { ok, unexpected: [...], allowed: [...], stale: [...] }. */
function evaluate(sql, allowlist = ALLOWLIST) {
  const statements = statementsOf(sql);
  const unexpected = statements.filter((s) => !allowlist.includes(s));
  const allowed = statements.filter((s) => allowlist.includes(s));
  const stale = allowlist.filter((a) => !statements.includes(a));
  return { ok: unexpected.length === 0, unexpected, allowed, stale };
}

/**
 * Run the diff against DATABASE_URL. Returns { status: 'pass'|'fail'|'skip', detail, result? }.
 * `exec` is injectable for tests.
 */
function check({ env = process.env, exec = execFileSync, npx = 'npx', spawnOpts = {} } = {}) {
  const ci = env.CI === 'true';
  if (!env.DATABASE_URL) {
    return ci ? { status: 'fail', detail: 'DATABASE_URL is not set in CI' } : { status: 'skip', detail: 'no DATABASE_URL — skipped (runs in CI)' };
  }
  let sql;
  try {
    sql = exec(npx, ['prisma', 'migrate', 'diff', '--from-url', env.DATABASE_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
      cwd: path.join(__dirname, '..'), stdio: 'pipe', env, encoding: 'utf8', ...spawnOpts
    });
  } catch (e) {
    // Never echo the URL: report only the Prisma error code if there is one.
    const code = (/\bP\d{4}\b/.exec(`${e.stderr || ''}${e.stdout || ''}`) || ['diff failed'])[0];
    return ci ? { status: 'fail', detail: `could not diff the database (${code})` } : { status: 'skip', detail: `database not reachable (${code}) — skipped (runs in CI)` };
  }
  const result = evaluate(sql);
  if (!result.ok) {
    return { status: 'fail', detail: `${result.unexpected.length} statement(s) outside the allowlist: ${result.unexpected.slice(0, 3).join(' | ').slice(0, 300)}`, result };
  }
  const note = result.stale.length ? `; ${result.stale.length} allowlisted statement(s) no longer appear — remove them` : '';
  return { status: 'pass', detail: `migrations = schema (${result.allowed.length} allowlisted join-table statement(s)${note})`, result };
}

if (require.main === module) {
  const { NPX, SHELL_SPAWN } = require('./_platform');
  const r = check({ npx: NPX, spawnOpts: SHELL_SPAWN });
  console.log(`schema drift: ${r.status.toUpperCase()} — ${r.detail}`);
  if (r.result && r.result.unexpected.length) for (const s of r.result.unexpected) console.log(`  unexpected: ${s}`);
  process.exit(r.status === 'fail' ? 1 : 0);
}

module.exports = { ALLOWLIST, statementsOf, evaluate, check };
