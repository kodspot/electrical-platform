'use strict';

// A date filter's day is a day where the users are (the server's TZ, Asia/Kolkata in
// production). `from` used to be parsed as UTC midnight — 05:30 in India — so whatever happened
// between midnight and 05:30 on the first day was left out; the ticket and audit-log filters
// also ended `to` at 05:29 the next morning, and three analytics endpoints ended it at 05:30 on
// the last day itself. [BUG-0055]
//
// Runs in India's zone, as production does: in UTC the old and the new parsing agree.
process.env.TZ = 'Asia/Kolkata';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestTicket,
  createTestAuditLog, createTestAlert, createTestAsset, createTestAssetEvent, createTestAssetFailure,
  createTestElectricalInspection
} = require('../helpers/db');
const { dayRange } = require('../../src/lib/dates');

const DAY = '2026-03-10';
// Just after midnight and just before the next one on DAY, and just after midnight the day after.
const EARLY = new Date('2026-03-10T01:00:00+05:30');
const LATE = new Date('2026-03-10T23:30:00+05:30');
const NEXT = new Date('2026-03-11T02:00:00+05:30');

describe('BUG-0055: a date filter\'s day runs from local midnight to local midnight', () => {
  let dbAvailable = false;
  let app, org, admin, supervisor, location, asset, auth;
  const createdOrgIds = [];
  const ids = {};

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);
    asset = await createTestAsset(org.id, location.id);
    const at = async (make) => Promise.all([EARLY, LATE, NEXT].map((when) => make(when).then((r) => r.id)));
    ids.tickets = await at((createdAt) => createTestTicket(org.id, location.id, { createdAt }));
    ids.logs = await at((createdAt) => createTestAuditLog(org.id, { createdAt }));
    ids.alerts = await at((createdAt) => createTestAlert(org.id, { createdAt }));
    ids.events = await at((eventDate) => createTestAssetEvent(org.id, asset.id, admin.id, { eventDate }));
    ids.failures = await at((failedAt) => createTestAssetFailure(org.id, asset.id, admin.id, { failedAt }));
    ids.records = await at((inspectedAt) => createTestElectricalInspection(org.id, location.id, supervisor.id, { inspectedAt }));
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.88.55.1' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    auth = { authorization: `Bearer ${res.json().token}` };
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('dayRange: a date-only value is the local day; a full timestamp is used as given', () => {
    assert.deepStrictEqual(dayRange(DAY, DAY), { gte: new Date('2026-03-10T00:00:00+05:30'), lte: new Date('2026-03-10T23:59:59.999+05:30') });
    assert.deepStrictEqual(dayRange('2026-03-10T06:00:00Z', undefined), { gte: new Date('2026-03-10T06:00:00Z') });
    assert.strictEqual(dayRange(undefined, ''), undefined);
  });

  for (const [name, url, key, listKey] of [
    ['tickets', '/api/tickets', 'tickets', 'tickets'],
    ['audit log', '/api/audit-logs', 'logs', 'logs'],
    ['alerts', '/api/alerts', 'alerts', 'alerts'],
    ['asset events', '/api/asset-events', 'events', 'events'],
    ['asset failures', '/api/asset-failures', 'failures', 'failures'],
    ['electrical inspections', '/api/electrical-inspections', 'records', 'records']
  ]) {
    it(`${name}: from=to=the day lists 00:00–23:59 of that day, and nothing of the next`, async (t) => {
      if (!dbAvailable) return t.skip('No database available');
      const res = await app.inject({ method: 'GET', url: `${url}?from=${DAY}&to=${DAY}&limit=100`, headers: auth });
      assert.strictEqual(res.statusCode, 200, res.body);
      const got = res.json()[listKey].map((r) => r.id).filter((id) => ids[key].includes(id)).sort();
      assert.deepStrictEqual(got, [ids[key][0], ids[key][1]].sort(), `${name}: 01:00 and 23:30 on ${DAY} only`);
    });
  }

  it('analytics by supervisor counts the whole day', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const res = await app.inject({ method: 'GET', url: `/api/analytics/supervisors?from=${DAY}&to=${DAY}`, headers: auth });
    assert.strictEqual(res.statusCode, 200, res.body);
    const row = res.json().find((s) => s.id === supervisor.id);
    assert.strictEqual(row.inspectionCount, 2);
  });
});
