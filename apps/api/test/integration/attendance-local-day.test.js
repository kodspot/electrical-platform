'use strict';

// "Supervisors can only mark attendance for today or yesterday" — but "today" was the UTC date,
// so between 00:00 and 05:30 in India the day before yesterday was still accepted, and the
// check had no upper bound, so any future date was too. The roster check had the same UTC
// "today". Both now use the local calendar date; attendance also refuses a future date.
// Admins keep their override. [BUG-0057]
//
// Runs in India's zone at 01:00, the hours in which the UTC date is still yesterday.
process.env.TZ = 'Asia/Kolkata';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestWorker } = require('../helpers/db');

const NOW = new Date('2026-03-10T01:00:00+05:30');
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const DAY_BEFORE = '2026-03-08';
const TOMORROW = '2026-03-11';

describe('BUG-0057: attendance and rosters for "today or yesterday" use the local date', () => {
  let dbAvailable = false;
  let app, org, location, worker, supAuth, adminAuth;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.57.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  /** POSTs at 01:00 IST on TODAY. */
  const postAt = async (t, url, headers, payload) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    try { return await app.inject({ method: 'POST', url, headers, payload }); } finally { t.mock.timers.reset(); }
  };
  const mark = (t, auth, date) => postAt(t, '/api/attendance/bulk', auth, { date, shift: 'MORNING', records: [{ workerId: worker.id, status: 'PRESENT' }] });
  const roster = (t, auth, date) => postAt(t, '/api/duty-roster', auth, { date, shift: 'MORNING', locationId: location.id });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);
    worker = await createTestWorker(org.id);
    supAuth = await login(await createTestUser(org.id, { role: 'SUPERVISOR' }));
    adminAuth = await login(await createTestUser(org.id, { role: 'ADMIN' }));
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('a supervisor marks today and yesterday — not the day before, not tomorrow', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (const [date, code] of [[TODAY, 200], [YESTERDAY, 200], [DAY_BEFORE, 400], [TOMORROW, 400]]) {
      const res = await mark(t, supAuth, date);
      assert.strictEqual(res.statusCode, code, `${date}: ${res.body}`);
    }
  });

  it('an admin may still mark any date', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (const date of [DAY_BEFORE, TOMORROW]) {
      const res = await mark(t, adminAuth, date);
      assert.strictEqual(res.statusCode, 200, `${date}: ${res.body}`);
    }
  });

  it('the dashboard\'s attendance today, at 01:00, is today\'s', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    // An org of its own, where only today is marked: the tests above also mark yesterday.
    const own = await createTestOrg();
    createdOrgIds.push(own.id);
    const ownWorker = await createTestWorker(own.id);
    const ownAdmin = await login(await createTestUser(own.id, { role: 'ADMIN' }));
    const marked = await postAt(t, '/api/attendance/bulk', ownAdmin, { date: TODAY, shift: 'MORNING', records: [{ workerId: ownWorker.id, status: 'PRESENT' }] });
    assert.strictEqual(marked.statusCode, 200, marked.body);
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    let res;
    try { res = await app.inject({ method: 'GET', url: '/api/attendance/today', headers: ownAdmin }); } finally { t.mock.timers.reset(); }
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.json().present, 1);
  });

  it('a supervisor\'s roster for the day before yesterday is refused at 01:00 too', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const res = await roster(t, supAuth, DAY_BEFORE);
    assert.strictEqual(res.statusCode, 400, res.body);
    const ok = await roster(t, supAuth, YESTERDAY);
    assert.ok(ok.statusCode < 300, `yesterday: ${ok.statusCode} ${ok.body}`);
  });
});
