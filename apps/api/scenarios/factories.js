'use strict';

/**
 * Shared entity factories. [platform-M3, DPS §4]
 *
 * These were extracted verbatim from test/helpers/db.js so BOTH the test suite and
 * the scenario/seed system build data through the SAME factory functions — one factory
 * system, not two (DPS "No Duplicate Systems"). test/helpers/db.js now re-exports these,
 * so every existing test import keeps working unchanged.
 *
 * Each factory takes `overrides` and spreads them last, so a scenario can supply
 * deterministic, realistic values (a fixed org name, known login credentials) instead
 * of the default `TEST_MARKER`-tagged values the tests rely on. All writes go through
 * the shared Prisma client, so tenant scoping and PII encryption behave exactly as in
 * production.
 */

const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const { prisma } = require('../src/lib/prisma');
const { BCRYPT_COST } = require('../src/lib/security');

const TEST_MARKER = '__wp1_test__';

/** Creates a throwaway Organization for a single test, name/slug tagged so cleanup is unambiguous. */
async function createTestOrg(overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.organization.create({
    data: {
      name: `${TEST_MARKER} Org ${suffix}`,
      slug: `${TEST_MARKER}-org-${suffix}`,
      status: 'ACTIVE',
      enabledModules: ['ele'],
      ...overrides
    }
  });
}

/** Creates a staff User (ADMIN/SUPERVISOR/SUPER_ADMIN) with a known plaintext password for login tests. */
async function createTestUser(orgId, { role = 'ADMIN', password = 'TestPass123', ...overrides } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: {
      orgId,
      name: `${TEST_MARKER} User ${suffix}`,
      email: `${TEST_MARKER}-${suffix}@example.test`,
      passwordHash,
      role,
      isActive: true,
      ...overrides
    }
  });
  return { ...user, plaintextPassword: password };
}

/** Creates a Location within an org, with a unique QR code. */
async function createTestLocation(orgId, overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.location.create({
    data: {
      orgId,
      name: `${TEST_MARKER} Location ${suffix}`,
      type: 'ROOM',
      qrCode: `${TEST_MARKER}-qr-${suffix}`,
      isActive: true,
      ...overrides
    }
  });
}

/** Creates a Ticket within an org/location. */
async function createTestTicket(orgId, locationId, overrides = {}) {
  return prisma.ticket.create({
    data: {
      orgId,
      locationId,
      title: `${TEST_MARKER} Ticket`,
      status: 'OPEN',
      priority: 'NORMAL',
      source: 'INTERNAL',
      module: 'ele',
      ...overrides
    }
  });
}

/** Creates a Worker within an org, with a known plaintext PIN for worker-login tests. */
async function createTestWorker(orgId, { pin = '1234', ...overrides } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const pinHash = await bcrypt.hash(pin, BCRYPT_COST);
  const worker = await prisma.worker.create({
    data: {
      orgId,
      name: `${TEST_MARKER} Worker ${suffix}`,
      employeeId: `${TEST_MARKER}-${suffix}`,
      pinHash,
      isActive: true,
      ...overrides
    }
  });
  return { ...worker, plaintextPin: pin };
}

/** Assigns a Worker to a Location (direct/inherited ticket coverage). */
async function createTestWorkerAssignment(orgId, workerId, locationId, overrides = {}) {
  return prisma.workerAssignment.create({
    data: { orgId, workerId, locationId, isPrimary: true, coverChildren: true, ...overrides }
  });
}

/** Assigns a Supervisor (User) to a Location. */
async function createTestSupervisorAssignment(orgId, supervisorId, locationId, overrides = {}) {
  return prisma.supervisorAssignment.create({
    data: { orgId, supervisorId, locationId, coverChildren: true, ...overrides }
  });
}

/** Creates an Attendance record for a worker. */
async function createTestAttendance(orgId, workerId, markedById, overrides = {}) {
  return prisma.attendance.create({
    data: {
      orgId, workerId, markedById,
      date: new Date(),
      shift: 'MORNING',
      status: 'PRESENT',
      ...overrides
    }
  });
}

/** Creates a DutyRoster for a location/supervisor. */
async function createTestDutyRoster(orgId, locationId, supervisorId, overrides = {}) {
  return prisma.dutyRoster.create({
    data: {
      orgId, locationId, supervisorId,
      date: new Date(),
      shift: 'MORNING',
      ...overrides
    }
  });
}

/** Creates an Asset within an org/location. */
async function createTestAsset(orgId, locationId, overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.asset.create({
    data: {
      orgId, locationId,
      assetCode: `${TEST_MARKER}-${suffix}`,
      name: `${TEST_MARKER} Asset ${suffix}`,
      category: 'Panel',
      status: 'OPERATIONAL',
      condition: 'GOOD',
      isActive: true,
      ...overrides
    }
  });
}

/** Creates an AssetEvent for an asset. */
async function createTestAssetEvent(orgId, assetId, loggedById, overrides = {}) {
  return prisma.assetEvent.create({
    data: {
      orgId, assetId, loggedById,
      type: 'INSPECTED',
      summary: `${TEST_MARKER} Event`,
      ...overrides
    }
  });
}

/** Creates an AssetFailure for an asset. */
async function createTestAssetFailure(orgId, assetId, loggedById, overrides = {}) {
  return prisma.assetFailure.create({
    data: {
      orgId, assetId, loggedById,
      title: `${TEST_MARKER} Failure`,
      severity: 'MEDIUM',
      status: 'OPEN',
      ...overrides
    }
  });
}

/** Creates an AlertRule within an org. */
async function createTestAlertRule(orgId, overrides = {}) {
  return prisma.alertRule.create({
    data: {
      orgId,
      name: `${TEST_MARKER} Rule`,
      trigger: 'ASSET_FAILURE_REPORTED',
      conditions: {},
      actions: [],
      isActive: true,
      ...overrides
    }
  });
}

/** Creates an Alert within an org. */
async function createTestAlert(orgId, overrides = {}) {
  return prisma.alert.create({
    data: {
      orgId,
      trigger: 'ASSET_FAILURE_REPORTED',
      severity: 'WARNING',
      title: `${TEST_MARKER} Alert`,
      ...overrides
    }
  });
}

/** Creates a ComplaintCategory within an org. */
async function createTestComplaintCategory(orgId, overrides = {}) {
  const suffix = randomUUID().slice(0, 8);
  return prisma.complaintCategory.create({
    data: {
      orgId,
      module: 'ele',
      key: `${TEST_MARKER}-${suffix}`,
      name: `${TEST_MARKER} Category ${suffix}`,
      isActive: true,
      ...overrides
    }
  });
}

/** Creates an InspectionTemplate within an org. */
async function createTestInspectionTemplate(orgId, overrides = {}) {
  return prisma.inspectionTemplate.create({
    data: {
      orgId,
      name: `${TEST_MARKER} Template`,
      locationTypes: [],
      isActive: true,
      ...overrides
    }
  });
}

/** Creates an ElectricalInspection within an org/location, authored by a supervisor User. */
async function createTestElectricalInspection(orgId, locationId, supervisorId, overrides = {}) {
  return prisma.electricalInspection.create({
    data: {
      orgId,
      locationId,
      supervisorId,
      shift: 'GENERAL',
      status: 'SUBMITTED',
      ...overrides
    }
  });
}

/** Creates a Notification within an org, for a user or worker. */
async function createTestNotification(orgId, overrides = {}) {
  return prisma.notification.create({
    data: {
      orgId,
      type: 'ticket_created',
      title: `${TEST_MARKER} Notification`,
      ...overrides
    }
  });
}

/** Creates an AuditLog entry within an org. */
async function createTestAuditLog(orgId, overrides = {}) {
  return prisma.auditLog.create({
    data: {
      orgId,
      actorType: 'ADMIN',
      action: `${TEST_MARKER}_action`,
      ...overrides
    }
  });
}

module.exports = {
  TEST_MARKER,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestTicket,
  createTestWorker,
  createTestWorkerAssignment,
  createTestSupervisorAssignment,
  createTestAttendance,
  createTestDutyRoster,
  createTestAsset,
  createTestAssetEvent,
  createTestAssetFailure,
  createTestAlertRule,
  createTestAlert,
  createTestComplaintCategory,
  createTestInspectionTemplate,
  createTestElectricalInspection,
  createTestNotification,
  createTestAuditLog
};
