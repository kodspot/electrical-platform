'use strict';

// WP-H: owner-approved fixes for coverage-matrix findings F2, F3 and F8
// (docs/testing/COVERAGE_MATRIX.md, "Characterisation findings").

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation,
  createTestWorker, createTestWorkerAssignment, createTestSupervisorAssignment
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { getAssignedSupervisorIds, getAssignedWorkerIds } = require('../../src/services/assignment-resolver');

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function login(app, user) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.plaintextPassword } });
  assert.strictEqual(res.statusCode, 200, 'fixture login must succeed');
  return res.json().token;
}

// Fire-and-forget notifications settle asynchronously: poll until the counts stop changing.
async function settledCount(where, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const n = await prisma.notification.count({ where });
    stableReads = n === last ? stableReads + 1 : 0;
    last = n;
    if (n > 0 && stableReads >= 3) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe('WP-H F2 — assignment order is stable: direct, then nearest ancestor, then isPrimary, createdAt, id', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin, root, floor, room, farSup, nearSup;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    root = await createTestLocation(org.id, { type: 'BUILDING' });
    floor = await createTestLocation(org.id, { type: 'FLOOR', parentId: root.id });
    room = await createTestLocation(org.id, { type: 'ROOM', parentId: floor.id });
    // The FARTHER supervisor's assignment is created first, so creation order alone
    // would pick the wrong one.
    farSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, farSup.id, root.id, { coverChildren: true });
    nearSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, nearSup.id, floor.id, { coverChildren: true });
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('the nearer covering supervisor comes first, identically over 5 calls', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await getAssignedSupervisorIds(room.id, org.id));
    for (const r of results) assert.deepStrictEqual(r, [nearSup.id, farSup.id]);
  });

  it('a direct assignment at the location beats any ancestor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const directSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const leaf = await createTestLocation(org.id, { type: 'ROOM', parentId: floor.id });
    await createTestSupervisorAssignment(org.id, directSup.id, leaf.id, { coverChildren: false });
    assert.deepStrictEqual(await getAssignedSupervisorIds(leaf.id, org.id), [directSup.id, nearSup.id, farSup.id]);
  });

  it('a public complaint and an internal ticket are both assigned to the nearer supervisor', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const pub = await app.inject({
      method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': nextIp() },
      payload: { locationId: room.id, issueType: 'LIGHT_NOT_WORKING' }
    });
    assert.strictEqual(pub.statusCode, 200);
    const stored = await prisma.ticket.findUnique({ where: { id: pub.json().ticket.id } });
    assert.strictEqual(stored.assignedToId, nearSup.id);

    const token = await login(app, admin);
    const internal = await app.inject({
      method: 'POST', url: '/api/tickets', headers: { authorization: `Bearer ${token}` },
      payload: { locationId: room.id, title: '__wp1_test__ F2 internal ticket' }
    });
    assert.strictEqual(internal.statusCode, 200);
    assert.strictEqual(internal.json().assignedToId, nearSup.id);
  });

  it('workers: nearest first, then isPrimary, then createdAt', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const farWorker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, farWorker.id, root.id, { coverChildren: true });
    const secondary = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, secondary.id, floor.id, { coverChildren: true, isPrimary: false });
    const primary = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, primary.id, floor.id, { coverChildren: true, isPrimary: true });
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(await getAssignedWorkerIds(room.id, org.id), [primary.id, secondary.id, farWorker.id]);
    }
  });
});

describe('WP-H F3 — an assigned supervisor gets one public-complaint notification, not two', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, otherOrg, location, assigned, unassigned, otherOrgSup;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    await createTestUser(org.id, { role: 'ADMIN' });
    location = await createTestLocation(org.id);
    assigned = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, assigned.id, location.id);
    unassigned = await createTestUser(org.id, { role: 'SUPERVISOR' });
    otherOrgSup = await createTestUser(otherOrg.id, { role: 'SUPERVISOR' });
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('assigned = exactly 1 row, unassigned = exactly 1, other org = 0', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({
      method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': nextIp() },
      payload: { locationId: location.id, issueType: 'LIGHT_NOT_WORKING' }
    });
    assert.strictEqual(res.statusCode, 200);
    const ticketId = res.json().ticket.id;

    assert.strictEqual(await settledCount({ userId: unassigned.id, entityId: ticketId }), 1, 'unassigned supervisor: the broadcast, once');
    assert.strictEqual(await settledCount({ userId: assigned.id, entityId: ticketId }), 1, 'assigned supervisor: the direct notification only');
    const direct = await prisma.notification.findFirst({ where: { userId: assigned.id, entityId: ticketId } });
    assert.strictEqual(direct.title, 'New public complaint assigned');
    assert.strictEqual(await prisma.notification.count({ where: { userId: otherOrgSup.id } }), 0, 'nothing in another org');
  });
});

describe('WP-H F8 — a worker always has an employeeId, so a created worker can log in', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, adminToken, saToken, superAdmin, existing;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    adminToken = await login(app, await createTestUser(org.id, { role: 'ADMIN' }));
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    saToken = await login(app, superAdmin);
    existing = await createTestWorker(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  const asAdmin = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${adminToken}` } });
  const asSA = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${saToken}` } });

  it('POST /api/workers without an employeeId (missing, empty, or blank) is rejected with 400', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    for (const extra of [{}, { employeeId: '' }, { employeeId: '   ' }]) {
      const res = await asAdmin('POST', '/api/workers', { name: `__wp1_test__ No EmpId ${Math.random()}`, ...extra });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(extra)}`);
    }
  });

  it('create with employeeId → admin sets PIN 123456 → worker-login succeeds', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const employeeId = `__wp1_test__-F8-${Date.now()}`;
    const created = await asAdmin('POST', '/api/workers', { name: `__wp1_test__ F8 journey ${Date.now()}`, employeeId: `  ${employeeId}  ` });
    assert.strictEqual(created.statusCode, 200, created.body);
    assert.strictEqual(created.json().employeeId, employeeId, 'employeeId is stored trimmed');

    const pin = await asAdmin('PATCH', `/api/workers/${created.json().id}/pin`, { pin: '123456' });
    assert.strictEqual(pin.statusCode, 200, pin.body);

    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/worker-login', payload: { orgSlug: org.slug, employeeId, pin: '123456' } });
    assert.strictEqual(loginRes.statusCode, 200, loginRes.body);
    assert.ok(loginRes.json().token);
  });

  it('PATCH /api/workers/:id cannot clear employeeId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    for (const employeeId of ['', '   ', null]) {
      const res = await asAdmin('PATCH', `/api/workers/${existing.id}`, { employeeId });
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(employeeId)}`);
    }
    const stored = await prisma.worker.findUnique({ where: { id: existing.id } });
    assert.strictEqual(stored.employeeId, existing.employeeId, 'existing employeeId unchanged');
  });

  it('the super-admin worker routes enforce the same rule', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const create = await asSA('POST', `/api/superadmin/organizations/${org.id}/workers`, { name: `__wp1_test__ SA no empid ${Date.now()}` });
    assert.strictEqual(create.statusCode, 400);
    const clear = await asSA('PATCH', `/api/superadmin/workers/${existing.id}`, { employeeId: '' });
    assert.strictEqual(clear.statusCode, 400);
  });
});
