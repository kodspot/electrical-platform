'use strict';

/**
 * Scenario: Demo Organization. [platform-M3, DPS §4]
 *
 * The base tenant every workflow scenario layers onto: one org (`ele` module) with a
 * small location hierarchy, one admin, two supervisors, three electricians — all with
 * fixed, documented login credentials, so the demo is deterministic and recognizable.
 *
 * Idempotent (find-or-create by slug): safe to use as a dependency and to run standalone
 * without duplicating the org. `npm run seed` deletes the demo org first (see the engine)
 * so a full seed is always a clean, deterministic rebuild.
 */

const { prisma } = require('../src/lib/prisma');
const {
  createTestOrg, createTestUser, createTestWorker, createTestLocation,
  createTestSupervisorAssignment, createTestWorkerAssignment
} = require('./factories');

// Fixed, documented identifiers — the source of the demo's determinism.
const DEMO_SLUG = 'kodspot-demo';
const DEMO_PASSWORD = 'DemoPass123';
const WORKER_PIN = '123456'; // exactly 6 digits — worker-login/creation enforce this (worker-auth.js, workers.js)
const ADMIN_EMAIL = 'admin@demo.kodspot.test';

async function loadExisting(org) {
  const [admin, supervisors, workers, locations] = await Promise.all([
    prisma.user.findFirst({ where: { orgId: org.id, role: 'ADMIN' } }),
    prisma.user.findMany({ where: { orgId: org.id, role: 'SUPERVISOR' }, orderBy: { email: 'asc' } }),
    prisma.worker.findMany({ where: { orgId: org.id }, orderBy: { employeeId: 'asc' } }),
    prisma.location.findMany({ where: { orgId: org.id }, orderBy: { name: 'asc' } })
  ]);
  const rooms = locations.filter((l) => l.type === 'ROOM');
  return { org, admin, supervisors, workers, locations, rooms, building: locations.find((l) => l.type === 'BUILDING') };
}

async function apply() {
  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) return loadExisting(existing);

  const org = await createTestOrg({ name: 'Kodspot Demo', slug: DEMO_SLUG, type: 'Hospital', enabledModules: ['ele'] });

  const admin = await createTestUser(org.id, { role: 'ADMIN', name: 'Demo Admin', email: ADMIN_EMAIL, password: DEMO_PASSWORD });
  const sup1 = await createTestUser(org.id, { role: 'SUPERVISOR', name: 'Supervisor Anaya', email: 'supervisor.a@demo.kodspot.test', password: DEMO_PASSWORD });
  const sup2 = await createTestUser(org.id, { role: 'SUPERVISOR', name: 'Supervisor Bhima', email: 'supervisor.b@demo.kodspot.test', password: DEMO_PASSWORD });

  const building = await createTestLocation(org.id, { name: 'Main Building', type: 'BUILDING', qrCode: 'DEMO-BLD-1' });
  const room1 = await createTestLocation(org.id, { name: 'Ward 1', type: 'ROOM', qrCode: 'DEMO-RM-1', parentId: building.id });
  const room2 = await createTestLocation(org.id, { name: 'ICU', type: 'ROOM', qrCode: 'DEMO-RM-2', parentId: building.id });

  const worker1 = await createTestWorker(org.id, { name: 'Electrician Chandra', employeeId: 'DEMO-EMP-1', pin: WORKER_PIN });
  const worker2 = await createTestWorker(org.id, { name: 'Electrician Devi', employeeId: 'DEMO-EMP-2', pin: WORKER_PIN });
  const worker3 = await createTestWorker(org.id, { name: 'Electrician Esha', employeeId: 'DEMO-EMP-3', pin: WORKER_PIN });

  // Coverage: supervisors + workers cover the whole building (inherited to its rooms).
  await createTestSupervisorAssignment(org.id, sup1.id, building.id);
  await createTestSupervisorAssignment(org.id, sup2.id, room2.id);
  await createTestWorkerAssignment(org.id, worker1.id, building.id);
  await createTestWorkerAssignment(org.id, worker2.id, building.id);
  await createTestWorkerAssignment(org.id, worker3.id, room2.id);

  return {
    org, admin,
    supervisors: [sup1, sup2],
    workers: [worker1, worker2, worker3],
    locations: [building, room1, room2],
    rooms: [room1, room2],
    building
  };
}

module.exports = {
  name: 'demo-organization',
  description: 'Base tenant: 1 org, hierarchy, 1 admin + 2 supervisors + 3 electricians (known credentials).',
  dependsOn: ['fresh-installation'],
  apply,
  DEMO_SLUG, DEMO_PASSWORD, WORKER_PIN, ADMIN_EMAIL
};
