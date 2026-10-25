'use strict';

// A floor can be deactivated while its rooms stay active (DELETE /locations/:id?force=true),
// and those rooms still take complaints. The ring (getAssignedWorkerIds) walked UP through the
// inactive floor and rang the electrician covering the building, but the electrician app's
// coverage walked DOWN only through active locations — so that electrician was rung for a
// ticket the app then answered 404 for. Both walks now follow the same tree. [BUG-0050]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation,
  createTestTicket, createTestWorker, createTestWorkerAssignment
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { getAssignedWorkerIds } = require('../../src/services/assignment-resolver');

describe('BUG-0050: an electrician rung for a ticket under a deactivated location can open it', () => {
  let dbAvailable = false;
  let app, org, building, floor, room, otherBuilding, adminAuth;
  let buildingWorker, directOnlyWorker, otherWorker;
  const workerAuth = {};
  const createdOrgIds = [];
  let ip = 0;
  const nextIp = () => `10.88.50.${++ip}`;
  const workerLogin = async (worker) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': nextIp() }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const openTicket = (auth, id) => app.inject({ method: 'GET', url: `/api/worker/tickets/${id}`, headers: auth });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    building = await createTestLocation(org.id, { type: 'BUILDING' });
    floor = await createTestLocation(org.id, { type: 'FLOOR', parentId: building.id });
    room = await createTestLocation(org.id, { type: 'ROOM', parentId: floor.id });
    otherBuilding = await createTestLocation(org.id, { type: 'BUILDING' });

    buildingWorker = await createTestWorker(org.id, { pin: '505050' });
    await createTestWorkerAssignment(org.id, buildingWorker.id, building.id, { coverChildren: true });
    // Assigned to the building only, without its children: covers nothing below it.
    directOnlyWorker = await createTestWorker(org.id, { pin: '515151' });
    await createTestWorkerAssignment(org.id, directOnlyWorker.id, building.id, { coverChildren: false });
    otherWorker = await createTestWorker(org.id, { pin: '525252' });
    await createTestWorkerAssignment(org.id, otherWorker.id, otherBuilding.id, { coverChildren: true });

    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': nextIp() }, payload: { email: admin.email, password: admin.plaintextPassword } });
    assert.strictEqual(login.statusCode, 200, login.body);
    adminAuth = { authorization: `Bearer ${login.json().token}` };

    // The admin deactivates the floor and confirms it although it has a room under it.
    const off = await app.inject({ method: 'DELETE', url: `/api/locations/${floor.id}?force=true`, headers: adminAuth });
    assert.strictEqual(off.statusCode, 200, off.body);
    assert.strictEqual((await prisma.location.findUnique({ where: { id: room.id } })).isActive, true, 'the room under it stays active');

    workerAuth.building = await workerLogin(buildingWorker);
    workerAuth.directOnly = await workerLogin(directOnlyWorker);
    workerAuth.other = await workerLogin(otherWorker);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('a ticket in an active room under the deactivated floor: the electrician it rings can open it, pick it up and see it listed', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, room.id);
    assert.ok((await getAssignedWorkerIds(room.id, org.id)).includes(buildingWorker.id), 'the ring reaches the building\'s electrician');

    const res = await openTicket(workerAuth.building, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
    const list = await app.inject({ method: 'GET', url: '/api/worker/tickets', headers: workerAuth.building });
    assert.strictEqual(list.statusCode, 200, list.body);
    assert.ok(list.json().tickets.some((x) => x.id === ticket.id), 'listed in My tickets');
    const pool = await app.inject({ method: 'GET', url: '/api/worker/tickets/pool', headers: workerAuth.building });
    assert.ok(pool.json().tickets.some((x) => x.id === ticket.id), 'listed in the pool');
    const pickup = await app.inject({ method: 'POST', url: `/api/worker/tickets/${ticket.id}/pickup`, headers: workerAuth.building, payload: {} });
    assert.strictEqual(pickup.statusCode, 200, pickup.body);
  });

  it('an open ticket at the deactivated floor itself stays with the electrician covering it from the building', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, floor.id);
    assert.ok((await getAssignedWorkerIds(floor.id, org.id)).includes(buildingWorker.id));
    const res = await openTicket(workerAuth.building, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
  });

  it('coverage still ends at the electrician\'s own subtree', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, room.id);
    const ring = await getAssignedWorkerIds(room.id, org.id);
    for (const [who, worker] of [['other', otherWorker], ['directOnly', directOnlyWorker]]) {
      assert.ok(!ring.includes(worker.id), `${who} is not rung`);
      const res = await openTicket(workerAuth[who], ticket.id);
      assert.strictEqual(res.statusCode, 404, `${who}: ${res.body}`);
    }
  });
});
