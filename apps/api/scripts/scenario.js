'use strict';

/**
 * `npm run scenario <name>` — apply one named business scenario. [platform-M3, DPS §2]
 * `npm run scenario --list` — list all available scenarios (read-only, no database).
 *
 * The atomic unit that seed/demo/tests/bug-repro all compose. Local-only when it
 * touches data (production-safety guard); `--list` is read-only.
 */

const arg = process.argv[2];

if (!arg || arg === '--list' || arg === '-l') {
  const { list } = require('../scenarios');
  console.log('\nAvailable scenarios:\n');
  for (const s of list()) console.log(`  ${s.name.padEnd(22)} ${s.description}`);
  console.log('\nApply one with:  npm run scenario <name>\n');
  process.exit(0);
}

const { loadRootEnv, assertLocalDevOnly, dbHostSafe } = require('./_platform');
const env = loadRootEnv();
assertLocalDevOnly(env);
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.DATABASE_URL = env.DATABASE_URL;

const { run, has } = require('../scenarios');
const { prisma } = require('../src/lib/prisma');

if (!has(arg)) {
  console.error(`Unknown scenario: "${arg}". Run \`npm run scenario --list\` to see them.`);
  process.exit(1);
}

(async () => {
  console.log(`scenario: applying "${arg}" at ${dbHostSafe(env.DATABASE_URL)} …`);
  await run(arg);
  console.log(`scenario: done — "${arg}" applied.`);
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => { console.error('scenario: failed:', e.message); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
