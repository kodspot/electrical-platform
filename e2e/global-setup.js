'use strict';

/**
 * Global setup for the e2e suite:
 *   1. refuse unless DATABASE_URL is a loopback `_e2e` database (support/safety.js, which
 *      imports apps/api/test/setup/safety-rules.js);
 *   2. apply migrations (idempotent);
 *   3. seed one run's worth of data through the shared scenario factories
 *      (apps/api/scenarios/factories.js) with generated, per-run-unique credentials only —
 *      traces and reports from this public repository are downloadable, so no real
 *      credential may ever appear in them.
 * The seed is written to .auth/seed.json (git-ignored) for the specs to read.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { assertE2eDatabase } = require('./support/safety');

const API_DIR = path.join(__dirname, '..', 'apps', 'api');
const SEED_FILE = path.join(__dirname, '.auth', 'seed.json');

module.exports = async function globalSetup() {
  assertE2eDatabase(process.env);

  const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: API_DIR, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32', env: process.env
  });
  if (migrate.status !== 0) throw new Error('[e2e] prisma migrate deploy failed');

  const f = require(path.join(API_DIR, 'scenarios', 'factories'));
  const { prisma } = require(path.join(API_DIR, 'src', 'lib', 'prisma'));

  const run = crypto.randomBytes(3).toString('hex');
  const password = () => `E2e-${crypto.randomBytes(9).toString('base64url')}`;
  const user = async (orgId, role, label) => {
    const pw = password();
    const u = await f.createTestUser(orgId, { role, password: pw, name: `E2E ${label} ${run}`, email: `e2e-${label.toLowerCase().replace(/\s+/g, '-')}-${run}@example.test` });
    return { id: u.id, email: u.email, password: pw, name: u.name };
  };
  const worker = async (orgId, label) => {
    const pin = String(crypto.randomInt(100000, 999999));
    const w = await f.createTestWorker(orgId, { pin, name: `E2E ${label} ${run}`, employeeId: `E2E-${label.toUpperCase()}-${run}` });
    return { id: w.id, employeeId: w.employeeId, pin, name: w.name };
  };

  // ── Org A: the main story ──
  const orgA = await f.createTestOrg({ name: `E2E Org A ${run}`, slug: `e2e-a-${run}` });
  const adminA = await user(orgA.id, 'ADMIN', 'Admin A');
  const building = await f.createTestLocation(orgA.id, { name: `E2E Block ${run}`, type: 'BUILDING' });
  const floor = await f.createTestLocation(orgA.id, { name: `E2E Floor 1 ${run}`, type: 'FLOOR', parentId: building.id });
  const otherFloor = await f.createTestLocation(orgA.id, { name: `E2E Floor 2 ${run}`, type: 'FLOOR', parentId: building.id });
  // The farther supervisor is assigned FIRST, so only the F2 ordering (nearest wins) picks
  // the nearer one.
  const supFar = await user(orgA.id, 'SUPERVISOR', 'Sup Far');
  await f.createTestSupervisorAssignment(orgA.id, supFar.id, building.id, { coverChildren: true });
  const supNear = await user(orgA.id, 'SUPERVISOR', 'Sup Near');
  await f.createTestSupervisorAssignment(orgA.id, supNear.id, floor.id, { coverChildren: true });
  const supOther = await user(orgA.id, 'SUPERVISOR', 'Sup Other');
  const elecFloor = await worker(orgA.id, 'Elec Floor');
  await f.createTestWorkerAssignment(orgA.id, elecFloor.id, floor.id, { coverChildren: true });
  const elecBlock = await worker(orgA.id, 'Elec Block');
  await f.createTestWorkerAssignment(orgA.id, elecBlock.id, building.id, { coverChildren: true });
  const elecElsewhere = await worker(orgA.id, 'Elec Elsewhere');
  await f.createTestWorkerAssignment(orgA.id, elecElsewhere.id, otherFloor.id, { coverChildren: true });

  // ── Org B: isolation checks ──
  const orgB = await f.createTestOrg({ name: `E2E Org B ${run}`, slug: `e2e-b-${run}` });
  const adminB = await user(orgB.id, 'ADMIN', 'Admin B');
  const locationB = await f.createTestLocation(orgB.id, { name: `E2E B Room ${run}`, type: 'ROOM' });
  const supB = await user(orgB.id, 'SUPERVISOR', 'Sup B');

  // ── Super-admin (Quality page) ──
  const superAdmin = await user(null, 'SUPER_ADMIN', 'Super Admin');

  const seed = {
    run,
    orgA: { id: orgA.id, slug: orgA.slug, name: orgA.name },
    orgB: { id: orgB.id, slug: orgB.slug, name: orgB.name },
    adminA, adminB, supFar, supNear, supOther, supB, superAdmin,
    workers: { elecFloor, elecBlock, elecElsewhere },
    locations: { building: building.id, floor: floor.id, otherFloor: otherFloor.id, locationB: locationB.id },
    names: { building: building.name, floor: floor.name }
  };
  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  await prisma.$disconnect();
};
