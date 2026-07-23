'use strict';

// Database-backed regression tests for WP8 (SuperAdmin Impersonation Audit &
// Authorization Hardening). The platform's only impersonation-like mechanism is
// a SuperAdmin "entering" an org via the X-Org-Id header (see
// middleware/auth.js#authenticateJWT and public/js/app.js's saHeaders()) — this
// file locks in two fixes made to that mechanism's audit trail:
//
// 1. registerSAuditHook previously only logged non-GET requests, so a SuperAdmin
//    browsing an org's dashboard (almost entirely GET traffic) left no audit
//    trail at all. It now logs every X-Org-Id request, tagged
//    'sa_org_context_read' or 'sa_org_context_write' by method.
// 2. tickets.js's resolve/verify/reopen and attendance.js's bulk-mark computed
//    audit actorType as `role === 'ADMIN' ? 'admin' : 'supervisor'` — for a
//    SuperAdmin acting via X-Org-Id, this silently mislabeled the action as
//    'supervisor'. Both now correctly attribute 'super_admin'.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestTicket,
  createTestWorker,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

// The sa_org_context_* audit write happens in an onResponse hook, which
// completes after the client-visible response — poll briefly rather than
// assuming it has already landed the instant app.inject() resolves.
async function pollForAuditLog(where) {
  let entry = null;
  for (let attempt = 0; attempt < 20 && !entry; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 25));
    entry = await prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' } });
  }
  return entry;
}

describe('WP8 — SuperAdmin org-entry (X-Org-Id) audit trail', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let org, superAdmin, tokenSA, location;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    org = await createTestOrg();
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);

    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: superAdmin.email, password: superAdmin.plaintextPassword }
    });
    assert.strictEqual(loginRes.statusCode, 200, 'fixture login for SuperAdmin must succeed');
    tokenSA = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    // SUPER_ADMIN fixtures have orgId: null, so Organization cascade delete
    // never reaches them — remove explicitly (matches the pattern already
    // established in tenant-isolation-superadmin.test.js from WP7).
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('a GET request via X-Org-Id creates an sa_org_context_read audit entry (previously: none at all)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const before_ = await prisma.auditLog.count({ where: { orgId: org.id, action: 'sa_org_context_read' } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenSA}`, 'x-org-id': org.id }
    });
    assert.strictEqual(res.statusCode, 200);

    const entry = await pollForAuditLog({ orgId: org.id, action: 'sa_org_context_read' });

    const after_ = await prisma.auditLog.count({ where: { orgId: org.id, action: 'sa_org_context_read' } });
    assert.strictEqual(after_, before_ + 1, 'a GET via X-Org-Id must now be audit-logged');

    assert.ok(entry, 'sa_org_context_read entry must exist');
    assert.strictEqual(entry.actorType, 'super_admin');
    assert.strictEqual(entry.actorId, superAdmin.id);
    assert.strictEqual(entry.newValue.method, 'GET');
    assert.strictEqual(entry.newValue.url, '/api/tickets');
  });

  it('a write via X-Org-Id still creates an sa_org_context_write audit entry (unchanged behavior)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ticket = await createTestTicket(org.id, location.id, { title: '__wp1_test__ SA-write-ticket', status: 'OPEN' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { authorization: `Bearer ${tokenSA}`, 'x-org-id': org.id },
      payload: { priority: 'HIGH' }
    });
    assert.strictEqual(res.statusCode, 200);

    const entry = await pollForAuditLog({ orgId: org.id, action: 'sa_org_context_write' });
    assert.ok(entry, 'a write via X-Org-Id must be audit-logged');
    assert.strictEqual(entry.actorType, 'super_admin');
    assert.strictEqual(entry.newValue.method, 'PATCH');
  });

  it('POST /tickets/:id/reopen by a SuperAdmin via X-Org-Id logs actorType super_admin, not supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ticket = await createTestTicket(org.id, location.id, {
      title: '__wp1_test__ SA-reopen-ticket',
      status: 'RESOLVED_PENDING_VERIFY'
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/reopen`,
      headers: { authorization: `Bearer ${tokenSA}`, 'x-org-id': org.id },
      payload: { note: 'SA regression test reopen' }
    });
    assert.strictEqual(res.statusCode, 200, 'SuperAdmin via X-Org-Id must be able to reopen (ORG_STAFF policy allows SUPER_ADMIN)');

    const entry = await prisma.auditLog.findFirst({
      where: { orgId: org.id, entityId: ticket.id, action: 'ticket_reopened' },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(entry, 'ticket_reopened audit entry must exist');
    assert.strictEqual(entry.actorType, 'super_admin', 'must not be mislabeled as supervisor');
    assert.strictEqual(entry.actorId, superAdmin.id);
  });

  it('POST /attendance/bulk by a SuperAdmin via X-Org-Id logs actorType super_admin, not supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const worker = await createTestWorker(org.id, { name: '__wp1_test__ SA-attendance-worker' });
    const todayStr = new Date().toISOString().slice(0, 10);

    const res = await app.inject({
      method: 'POST',
      url: '/api/attendance/bulk',
      headers: { authorization: `Bearer ${tokenSA}`, 'x-org-id': org.id },
      payload: {
        date: todayStr,
        shift: 'MORNING',
        records: [{ workerId: worker.id, status: 'PRESENT' }]
      }
    });
    assert.strictEqual(res.statusCode, 200, 'SuperAdmin via X-Org-Id must be able to mark attendance');

    const entry = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: 'attendance_marked' },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(entry, 'attendance_marked audit entry must exist');
    assert.strictEqual(entry.actorType, 'super_admin', 'must not be mislabeled as supervisor');
    assert.strictEqual(entry.actorId, superAdmin.id);
  });

  it('a non-SuperAdmin ADMIN acting on their own org (no X-Org-Id) never triggers sa_org_context logging', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    const tokenAdmin = loginRes.json().token;

    const before_ = await prisma.auditLog.count({ where: { orgId: org.id, action: { in: ['sa_org_context_read', 'sa_org_context_write'] } } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenAdmin}` }
    });
    assert.strictEqual(res.statusCode, 200);

    const after_ = await prisma.auditLog.count({ where: { orgId: org.id, action: { in: ['sa_org_context_read', 'sa_org_context_write'] } } });
    assert.strictEqual(after_, before_, 'an ordinary org admin\'s own request must never produce sa_org_context_* noise');
  });

  it('the affected org\'s own GET /api/audit-logs surfaces the SuperAdmin\'s access (transparency, not just the SA-side viewer)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    const tokenAdmin = loginRes.json().token;

    // Trigger at least one sa_org_context_read entry for this org.
    await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenSA}`, 'x-org-id': org.id }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs?action=sa_org_context_read',
      headers: { authorization: `Bearer ${tokenAdmin}` }
    });
    assert.strictEqual(res.statusCode, 200);
    const logs = res.json().logs;
    assert.ok(logs.length > 0, 'the org\'s own admin must be able to see SuperAdmin read-access in their own audit log');
    assert.ok(logs.every((l) => l.actorType === 'super_admin'));
  });
});
