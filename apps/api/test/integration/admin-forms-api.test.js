'use strict';

// The API side of two admin/supervisor form defects (the browser side is e2e/tests/forms.spec.js):
// - BUG-0021: an edit form clears an optional field by SENDING it empty — PATCH /assets/:id must
//   accept null for its numeric fields and store null for '' text and dates;
// - BUG-0025: the duty roster's suggested electricians include those covering the location
//   from an ancestor (coverChildren), as the complaint ring does — not only direct assignments.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const f = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('admin / supervisor forms — API contract', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, otherOrg, adminAuth, supAuth, building, floor, elsewhere, coveringWorker, directWorker, farWorker, inactiveWorker;
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.33.0.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };

  before(async () => {
    dbAvailable = await f.isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await f.createTestOrg({ enabledModules: ['ele', 'asset'] });
    otherOrg = await f.createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    adminAuth = await login(await f.createTestUser(org.id, { role: 'ADMIN' }));
    supAuth = await login(await f.createTestUser(org.id, { role: 'SUPERVISOR' }));
    building = await f.createTestLocation(org.id, { type: 'BUILDING' });
    floor = await f.createTestLocation(org.id, { type: 'FLOOR', parentId: building.id });
    elsewhere = await f.createTestLocation(org.id);
    coveringWorker = await f.createTestWorker(org.id);
    await f.createTestWorkerAssignment(org.id, coveringWorker.id, building.id, { coverChildren: true });
    directWorker = await f.createTestWorker(org.id);
    await f.createTestWorkerAssignment(org.id, directWorker.id, floor.id, { coverChildren: false });
    farWorker = await f.createTestWorker(org.id);
    await f.createTestWorkerAssignment(org.id, farWorker.id, elsewhere.id);
    inactiveWorker = await f.createTestWorker(org.id, { isActive: false });
    await f.createTestWorkerAssignment(org.id, inactiveWorker.id, building.id, { coverChildren: true });
  });

  after(async () => {
    if (!dbAvailable) return;
    await f.cleanupTestOrgs(createdOrgIds);
  });

  it('BUG-0021: PATCH /assets/:id with the cleared fields the edit form sends stores them as empty', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const asset = await f.createTestAsset(org.id, floor.id, {
      make: 'Schneider', serialNo: 'SN-1', warrantyExpiry: new Date('2030-01-31'), maintenanceCycleDays: 90, purchaseCost: 12500
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/assets/${asset.id}`, headers: adminAuth,
      payload: { make: '', serialNo: '', warrantyExpiry: '', maintenanceCycleDays: null, purchaseCost: null }
    });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode} ${res.body.slice(0, 160)}`);
    const now = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.deepStrictEqual([now.make, now.serialNo, now.warrantyExpiry, now.maintenanceCycleDays, now.purchaseCost], [null, null, null, null, null]);
    // Omitting a field still means "unchanged".
    await prisma.asset.update({ where: { id: asset.id }, data: { make: 'ABB' } });
    assert.strictEqual((await app.inject({ method: 'PATCH', url: `/api/assets/${asset.id}`, headers: adminAuth, payload: { name: 'Renamed' } })).statusCode, 200);
    assert.strictEqual((await prisma.asset.findUnique({ where: { id: asset.id } })).make, 'ABB');
  });

  it('BUG-0025: a roster for a floor suggests the electricians covering it — directly or from its building — and no one else', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const res = await app.inject({ method: 'GET', url: `/api/duty-roster/suggested-workers?locationId=${floor.id}`, headers: supAuth });
    assert.strictEqual(res.statusCode, 200, res.body);
    const ids = res.json().suggested.map((w) => w.id).sort();
    assert.deepStrictEqual(ids, [coveringWorker.id, directWorker.id].sort(), 'covering (from the building) and direct; not elsewhere, not inactive');
    const all = res.json().allWorkers.map((w) => w.id);
    assert.ok(all.includes(farWorker.id) && !all.includes(inactiveWorker.id), 'the "add more" list is every active electrician');

    const top = await app.inject({ method: 'GET', url: `/api/duty-roster/suggested-workers?locationId=${building.id}`, headers: supAuth });
    assert.deepStrictEqual(top.json().suggested.map((w) => w.id), [coveringWorker.id]);
  });

  it('suggestions never cross organizations', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const foreign = await f.createTestLocation(otherOrg.id);
    const foreignWorker = await f.createTestWorker(otherOrg.id);
    await f.createTestWorkerAssignment(otherOrg.id, foreignWorker.id, foreign.id);
    const res = await app.inject({ method: 'GET', url: `/api/duty-roster/suggested-workers?locationId=${foreign.id}`, headers: supAuth });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json().suggested, []);
    assert.ok(!res.json().allWorkers.some((w) => w.id === foreignWorker.id));
  });
});
