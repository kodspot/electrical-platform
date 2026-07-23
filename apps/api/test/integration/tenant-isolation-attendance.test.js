'use strict';

// Database-backed integration tests proving attendance.js (routes/attendance.js) never
// leaks another org's Attendance records and rejects marking attendance for a
// foreign-org worker. Follows the exact pattern of
// test/integration/tenant-isolation.test.js (WP1, H1).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestWorker,
  createTestAttendance,
  cleanupTestOrgs
} = require('../helpers/db');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

describe('tenant isolation — attendance.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, workerA, workerB, attendanceA, attendanceB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    const adminB = await createTestUser(orgB.id, { role: 'ADMIN' });

    workerA = await createTestWorker(orgA.id, { name: '__wp1_test__ Worker A' });
    workerB = await createTestWorker(orgB.id, { name: '__wp1_test__ Worker B' });

    attendanceA = await createTestAttendance(orgA.id, workerA.id, adminA.id, {
      date: new Date(`${todayStr()}T00:00:00Z`),
      shift: 'MORNING',
      status: 'PRESENT'
    });
    attendanceB = await createTestAttendance(orgB.id, workerB.id, adminB.id, {
      date: new Date(`${todayStr()}T00:00:00Z`),
      shift: 'MORNING',
      status: 'PRESENT'
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: adminA.email, password: adminA.plaintextPassword }
    });
    assert.strictEqual(loginRes.statusCode, 200, 'fixture login for Admin A must succeed');
    tokenA = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('GET /api/attendance never returns another org\'s attendance records', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/attendance?date=${todayStr()}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    const attendanceIds = body.records.map((r) => r.attendanceId).filter(Boolean);
    const workerIds = body.records.map((r) => r.worker.id);
    assert.ok(attendanceIds.includes(attendanceA.id), 'Org A\'s own attendance record must be visible');
    assert.ok(!attendanceIds.includes(attendanceB.id), 'Org B\'s attendance record must never appear');
    assert.ok(!workerIds.includes(workerB.id), 'Org B\'s worker must never appear in Org A\'s attendance list');
  });

  it('POST /api/attendance/bulk rejects marking attendance for a foreign-org workerId', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/attendance/bulk',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        date: todayStr(),
        shift: 'AFTERNOON',
        records: [{ workerId: workerB.id, status: 'PRESENT' }]
      }
    });

    assert.strictEqual(res.statusCode, 400, 'a worker from another org must not be markable by Org A');
  });

  it('PATCH /api/attendance/:id cannot modify another org\'s attendance record', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/attendance/${attendanceB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { status: 'ABSENT' }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/attendance/report never aggregates another org\'s attendance', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/attendance/report?from=${todayStr()}&to=${todayStr()}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const workerIds = res.json().workers.map((w) => w.worker.id);
    assert.ok(!workerIds.includes(workerB.id), 'Org B\'s worker must never appear in Org A\'s report');
  });
});
