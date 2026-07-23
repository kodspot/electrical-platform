'use strict';

/**
 * Bug reproduction CLI. [platform-M4, DPS §6]
 *
 *   npm run bug:list                 — list the bug scenario registry (read-only, no DB)
 *   npm run bug:run -- <ID>          — reproduce a bug's triggering state in the local DB
 *   npm run bug:validate [-- <ID>]   — reproduce + assert the fixed behavior still holds
 *
 * `run`/`validate` mutate data and are production-guarded (local-only). Reuses the M3
 * scenario engine and the bug runner — no execution logic is duplicated here.
 */

const sub = process.argv[2] || 'list';
const id = process.argv[3];

// ── list: read-only, no database, no guard ──
if (sub === 'list') {
  const registry = require('../scenarios/bugs/registry');
  console.log('\nBug scenario registry:\n');
  for (const b of registry.list()) {
    console.log(`  ${b.id}  [${b.severity}/${b.status}]  ${String(b.module).padEnd(11)} ${b.title}`);
  }
  console.log('\n  Reproduce a bug:  npm run bug:run -- <ID>');
  console.log('  Validate fixes:   npm run bug:validate         (all)   /   npm run bug:validate -- <ID>\n');
  process.exit(0);
}

// ── run / validate: mutate data → guard + load env before requiring the runner ──
const { loadRootEnv, assertLocalDevOnly, dbHostSafe } = require('./_platform');
const env = loadRootEnv();
assertLocalDevOnly(env);
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.DATABASE_URL = env.DATABASE_URL;

const registry = require('../scenarios/bugs/registry');
const runner = require('../scenarios/bugs/runner');
const { prisma } = require('../src/lib/prisma');

async function finish(code) { try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(code); }

(async () => {
  if (sub === 'run') {
    if (!id || !registry.has(id)) { console.error(`Usage: npm run bug:run -- <ID>. Unknown bug: "${id}". Try \`npm run bug:list\`.`); return finish(1); }
    console.log(`bug:run — reproducing ${id} at ${dbHostSafe(env.DATABASE_URL)} …`);
    await runner.applyBug(registry.get(id));
    console.log(`bug:run — ${id} triggering state applied to the local database. Inspect it via \`npm run dev\`.`);
    return finish(0);
  }

  if (sub === 'validate') {
    if (id && !registry.has(id)) { console.error(`Unknown bug: "${id}". Try \`npm run bug:list\`.`); return finish(1); }
    const bugs = id ? [registry.get(id)] : registry.all();
    console.log(`bug:validate — reproducing ${bugs.length} bug(s) at ${dbHostSafe(env.DATABASE_URL)} …\n`);
    let failures = 0;
    const createdOrgIds = [];
    for (const bug of bugs) {
      const ctx = {};
      try {
        const r = await runner.validateBug(bug, ctx);
        console.log(`  ${r.ok ? '✓' : '✗'} ${bug.id}  ${r.detail || ''}`);
        if (!r.ok) failures++;
      } catch (e) { failures++; console.log(`  ✗ ${bug.id}  ERROR: ${e.message}`); }
      if (ctx[bug.id] && ctx[bug.id].org) createdOrgIds.push(ctx[bug.id].org.id);
    }
    // Clean up the isolated orgs each bug created (cascade removes their data).
    if (createdOrgIds.length) await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    console.log(failures
      ? `\nbug:validate — ${failures} REGRESSION(S) present. A fixed bug has come back.`
      : '\nbug:validate — all fixed behaviors hold. No regressions.');
    return finish(failures ? 1 : 0);
  }

  console.error(`Unknown subcommand: "${sub}". Use: list | run | validate.`);
  return finish(1);
})().catch((e) => { console.error('bug:', e.message); return finish(1); });
