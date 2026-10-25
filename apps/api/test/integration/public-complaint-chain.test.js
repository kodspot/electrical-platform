'use strict';

// W1 + W3 end to end at the API level: the QR page routes, the public location lookup, a
// guest complaint WITH a photo (local storage driver), the auto-assignment through the
// location hierarchy, and exactly who is notified — the covering supervisor (direct,
// urgent), the org's other supervisors (broadcast, once), the admins, and the electricians
// covering the location (the "ring"), but not an electrician elsewhere. Closes the
// COVERAGE_MATRIX P1 gaps on W1/W3 (assignedToId, notifyWorkers, supervisor rows,
// image upload, /s/:code and /scan/:code).

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-chain-'));
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  cleanupTestOrgs,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestWorker,
  createTestWorkerAssignment,
  createTestSupervisorAssignment
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function multipart(fields, image, mime = 'image/png') {
  const boundary = '----complaint' + crypto.randomUUID().replace(/-/g, '');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (image) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo"\r\nContent-Type: ${mime}\r\n\r\n`), image, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function eventually(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe('W1/W3 — QR complaint with a photo → assignment → who is notified', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin, coveringSup, otherSup, building, room, elsewhere, ringWorker, farWorker;
  let ip = 0;
  const guestHeaders = () => ({ 'x-forwarded-for': `10.88.0.${++ip}` });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    coveringSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    otherSup = await createTestUser(org.id, { role: 'SUPERVISOR' });
    building = await createTestLocation(org.id, { type: 'BUILDING' });
    room = await createTestLocation(org.id, { parentId: building.id, qrCode: 'CHAIN' + crypto.randomUUID().slice(0, 6).toUpperCase() });
    elsewhere = await createTestLocation(org.id);
    // Coverage through the hierarchy: assigned to the building, covering its children.
    await createTestSupervisorAssignment(org.id, coveringSup.id, building.id, { coverChildren: true });
    ringWorker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, ringWorker.id, building.id, { coverChildren: true });
    farWorker = await createTestWorker(org.id);
    await createTestWorkerAssignment(org.id, farWorker.id, elsewhere.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  });

  it('the QR URLs /s/:code and /scan/:code serve the complaint page, and the lookup resolves the code', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (const url of [`/s/${room.qrCode}`, `/scan/${room.qrCode}`]) {
      const res = await app.inject({ method: 'GET', url });
      assert.strictEqual(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /text\/html/);
    }
    const lookup = await app.inject({ method: 'GET', url: `/api/public/location/${room.qrCode}`, headers: guestHeaders() });
    assert.strictEqual(lookup.statusCode, 200, lookup.body);
    assert.strictEqual(lookup.json().id || lookup.json().location?.id, room.id);
    assert.deepStrictEqual(lookup.json().enabledModules, ['ele']);
    const unknown = await app.inject({ method: 'GET', url: '/api/public/location/NOPE000000', headers: guestHeaders() });
    assert.strictEqual(unknown.statusCode, 404);
  });

  it('a complaint with a photo is stored, auto-assigned to the covering supervisor, and notifies exactly the right people', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { payload, headers } = multipart({ locationId: room.id, issueType: 'LIGHT_NOT_WORKING', description: 'Tube light flickers', guestName: 'Asha', consent: 'true' }, PNG);
    const res = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { ...headers, ...guestHeaders() }, payload });
    assert.strictEqual(res.statusCode, 200, res.body);
    const id = res.json().ticket.id;

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    assert.strictEqual(ticket.source, 'PUBLIC');
    assert.strictEqual(ticket.status, 'OPEN');
    assert.strictEqual(ticket.assignedToId, coveringSup.id, 'auto-assigned through the building coverage');
    assert.match(ticket.imageUrl, new RegExp(`^/images/uploads/${org.id}/`));
    assert.ok(fs.existsSync(path.join(STORAGE_DIR, ticket.imageUrl.replace(/^\/images\//, ''))), 'the photo is stored');

    const rows = async () => prisma.notification.findMany({ where: { orgId: org.id, entityId: id } });
    await eventually(async () => (await rows()).length >= 4);
    await new Promise((r) => setTimeout(r, 200)); // let any duplicate land before counting
    const all = await rows();
    const forUser = (u) => all.filter((n) => n.userId === u.id);
    const forWorker = (w) => all.filter((n) => n.workerId === w.id);

    assert.strictEqual(forUser(coveringSup).length, 1, 'the covering supervisor: one notification (F3)');
    assert.strictEqual(forUser(coveringSup)[0].title, 'New public complaint assigned');
    assert.strictEqual(forUser(coveringSup)[0].isUrgent, true);
    assert.strictEqual(forUser(otherSup).length, 1, 'another supervisor: one broadcast');
    assert.strictEqual(forUser(admin).length, 1, 'the admin: one');
    assert.strictEqual(forWorker(ringWorker).length, 1, 'the covering electrician is rung');
    assert.match(forWorker(ringWorker)[0].body, new RegExp(building.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'with the location breadcrumb');
    assert.strictEqual(forWorker(farWorker).length, 0, 'an electrician elsewhere is not');
  });

  it('a photo that is not an allowed image is refused before any ticket is created', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const before = await prisma.ticket.count({ where: { orgId: org.id } });
    const gif = multipart({ locationId: room.id, issueType: 'LIGHT_NOT_WORKING' }, Buffer.from('GIF89a'), 'image/gif');
    const r1 = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { ...gif.headers, ...guestHeaders() }, payload: gif.payload });
    assert.strictEqual(r1.statusCode, 400);
    const fake = multipart({ locationId: room.id, issueType: 'LIGHT_NOT_WORKING' }, Buffer.from('not really a png'));
    const r2 = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { ...fake.headers, ...guestHeaders() }, payload: fake.payload });
    assert.strictEqual(r2.statusCode, 400);
    assert.strictEqual(await prisma.ticket.count({ where: { orgId: org.id } }), before);
  });
});
