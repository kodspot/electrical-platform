'use strict';

/**
 * `npm run seed [profile]` — apply a business-scenario profile to the local database.
 * [platform-M3, DPS §2/§5]  Default profile: "demo" (the canonical demo dataset).
 *
 * Deterministic: the demo org is deleted and rebuilt from fixed values, so every seed
 * produces the same recognizable state. Local-only (production-safety guard).
 */

const { loadRootEnv, assertLocalDevOnly, dbHostSafe } = require('./_platform');

const env = loadRootEnv();
assertLocalDevOnly(env);
// Provide the app's env, forcing DATABASE_URL to exactly the (guard-validated) local value.
for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
process.env.DATABASE_URL = env.DATABASE_URL;

// Required AFTER DATABASE_URL is set (the Prisma client reads it at construction).
const { seed } = require('../scenarios');
const demoOrg = require('../scenarios/demo-organization');
const { prisma } = require('../src/lib/prisma');

async function main(profile = 'demo') {
  console.log(`seed: applying "${profile}" profile at ${dbHostSafe(env.DATABASE_URL)} …`);
  const ctx = await seed(profile);
  const org = ctx['demo-organization'].org;
  console.log(`\nseed: done. Demo organization "${org.name}" (slug: ${org.slug}).`);
  console.log(`  Admin:      ${demoOrg.ADMIN_EMAIL}  /  ${demoOrg.DEMO_PASSWORD}`);
  console.log(`  Electrician PIN (all): ${demoOrg.WORKER_PIN}`);
  await prisma.$disconnect();
}

if (require.main === module) {
  main(process.argv[2] || 'demo')
    .then(() => process.exit(0))
    .catch(async (e) => { console.error('\nseed: failed:', e.message); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
}

module.exports = { main };
