'use strict';

// Analytics charts grouped inspections by UTC day: SQL DATE("inspectedAt") on a column that
// holds UTC, and toISOString() date keys. In India an inspection between 00:00 and 05:30
// counted on the day before, and the report's day labels were shifted by one (its first label
// before the range, its last day missing), because local midnight is the previous day in UTC.
// Every chart now groups by the local day (the server's TZ). [BUG-0056]
//
// Runs in India's zone, as production does: in UTC the old and the new grouping agree.
process.env.TZ = 'Asia/Kolkata';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestElectricalInspection } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { localDateKey } = require('../../src/lib/dates');

const DAY = '2026-03-10';
const EARLY = new Date('2026-03-10T01:00:00+05:30');
const LATE = new Date('2026-03-10T23:30:00+05:30');

describe('BUG-0056: analytics group inspections by the local day', () => {
  let dbAvailable = false;
  let app, org, room, auth, saAuth, superAdmin;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.56.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const get = async (url, headers = auth) => {
    const res = await app.inject({ method: 'GET', url, headers });
    assert.strictEqual(res.statusCode, 200, `${url}: ${res.body}`);
    return res.json();
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    room = await createTestLocation(org.id, { type: 'ROOM' });
    await createTestElectricalInspection(org.id, room.id, supervisor.id, { inspectedAt: EARLY, faultyCount: 1 });
    await createTestElectricalInspection(org.id, room.id, supervisor.id, { inspectedAt: LATE });
    // Today, a minute after local midnight: the day before in UTC.
    const today = new Date(); today.setHours(0, 1, 0, 0);
    await createTestElectricalInspection(org.id, room.id, supervisor.id, { inspectedAt: today, faultyCount: 2 });
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    auth = await login(admin);
    saAuth = await login(superAdmin);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('the report: its period and daily trend are the local days asked for', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const body = await get(`/api/analytics/report?from=${DAY}&to=${DAY}`);
    assert.deepStrictEqual(body.period.from, DAY);
    assert.deepStrictEqual(body.period.to, DAY);
    assert.deepStrictEqual(body.trend, [{ date: DAY, count: 2 }]);
    assert.deepStrictEqual(body.faultTrend, [{ date: DAY, count: 1 }]);
  });

  it('the room heatmap: one column for the day, with both inspections in it', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const body = await get(`/api/analytics/room-heatmap?from=${DAY}&to=${DAY}`);
    assert.deepStrictEqual(body.dates, [DAY]);
    const row = body.locations.find((l) => l.id === room.id);
    assert.strictEqual(row.days[0].done, 2);
  });

  it('the inspection and fault trends count today\'s 00:01 inspection under today', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const today = localDateKey();
    for (const url of ['/api/analytics/inspection-trend?days=3', '/api/analytics/fault-trend?days=3']) {
      const { trend } = await get(url);
      assert.deepStrictEqual(trend[trend.length - 1], { date: today, count: 1 }, url);
    }
  });

  it('a location\'s history marks today as inspected, with faults', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const body = await get(`/api/analytics/location/${room.id}/history?days=3`);
    const today = body.dailyStatus.find((d) => d.date === localDateKey());
    assert.ok(today, 'today is in the history');
    assert.strictEqual(today.inspections, 1);
    assert.strictEqual(today.status, 'HAS_FAULTS');
  });

  it('the super-admin dashboard and AI usage still answer, grouped by day', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { dailyTrend } = await get('/api/superadmin/analytics', saAuth);
    assert.ok(Array.isArray(dailyTrend));
    assert.ok(dailyTrend.some((d) => String(d.date).slice(0, 10) === localDateKey()), 'today has inspections');
    const usage = await get('/api/superadmin/ai/usage', saAuth);
    assert.ok(usage.period);
  });
});
