'use strict';

// The resolve → verify → reopen part of the ticket lifecycle, with real proof-photo uploads
// through the local storage driver (STORAGE_DRIVER=local), for every role that can act on it:
// the admin, the assigned supervisor, another supervisor, another org's admin, the electrician
// covering the location, and the guest who reviews a public ticket's resolution.
// Closes the COVERAGE_MATRIX gaps "POST /tickets/:id/resolve with a proof photo",
// "POST /worker/tickets/:id/resolve success" and "POST /tickets/:id/verify", and holds the
// regressions BUG-0015..BUG-0018.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The local storage driver reads its root once, at load: set it before the app loads.
const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-verify-'));
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
  createTestTicket,
  createTestWorker,
  createTestWorkerAssignment,
  createTestSupervisorAssignment
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** A multipart/form-data body with text fields and an optional `image` file. */
function multipart(fields = {}, image = PNG) {
  const boundary = '----resolve' + crypto.randomUUID().replace(/-/g, '');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (image) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="proof.png"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(image, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

/** Polls fn until it returns a truthy value (fire-and-forget notifications land a little later). */
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

const tokenOf = (reviewUrl) => String(reviewUrl || '').split('/').pop();

describe('ticket resolve → verify → reopen, every role', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, otherOrg, admin, otherAdmin, supA, supB, worker, location;
  let adminToken, otherAdminToken, supAToken, supBToken, workerToken;

  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const staffLogin = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': nextIp() }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json().token;
  };
  const staffResolve = (token, id, fields = { note: 'Replaced the fitting' }, image = PNG) => {
    const { payload, headers } = multipart(fields, image);
    return app.inject({ method: 'POST', url: `/api/tickets/${id}/resolve`, headers: { ...auth(token), ...headers }, payload });
  };
  const workerResolve = (id, fields = { note: 'Fixed' }, image = PNG) => {
    const { payload, headers } = multipart(fields, image);
    return app.inject({ method: 'POST', url: `/api/worker/tickets/${id}/resolve`, headers: { ...auth(workerToken), ...headers }, payload });
  };
  const post = (token, url, payload = {}) => app.inject({ method: 'POST', url, headers: auth(token), payload });
  const guest = (method, token, payload) => app.inject({ method, url: `/api/public/review/${token}`, headers: { 'x-forwarded-for': nextIp() }, payload });
  const ticketNow = (id) => prisma.ticket.findUnique({ where: { id } });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();

    org = await createTestOrg();
    otherOrg = await createTestOrg();
    createdOrgIds.push(org.id, otherOrg.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    otherAdmin = await createTestUser(otherOrg.id, { role: 'ADMIN' });
    supA = await createTestUser(org.id, { role: 'SUPERVISOR' });
    supB = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);
    await createTestSupervisorAssignment(org.id, supA.id, location.id);
    worker = await createTestWorker(org.id, { pin: '482913' });
    await createTestWorkerAssignment(org.id, worker.id, location.id);

    adminToken = await staffLogin(admin);
    otherAdminToken = await staffLogin(otherAdmin);
    supAToken = await staffLogin(supA);
    supBToken = await staffLogin(supB);
    const wl = await app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': nextIp() }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    assert.strictEqual(wl.statusCode, 200, wl.body);
    workerToken = wl.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  });

  // ── Staff resolve (POST /tickets/:id/resolve) ──

  it('the admin resolves a ticket with a proof photo (RESOLVED, photo stored); without a photo it is refused', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS' });

    const noPhoto = await staffResolve(adminToken, ticket.id, { note: 'n' }, null);
    assert.strictEqual(noPhoto.statusCode, 400);
    assert.match(noPhoto.json().error, /proof photo/i);

    const res = await staffResolve(adminToken, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
    const body = res.json();
    assert.strictEqual(body.status, 'RESOLVED');
    assert.match(body.resolvedImageUrl, new RegExp(`^/images/uploads/${org.id}/`));
    assert.ok(fs.existsSync(path.join(STORAGE_DIR, body.resolvedImageUrl.replace(/^\/images\//, ''))), 'the proof photo is stored');
    assert.strictEqual(body.reviewUrl, undefined, 'an internal ticket gets no guest review link');
  });

  it('only the assigned supervisor may resolve: another supervisor gets 403, another org 404', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });

    assert.strictEqual((await staffResolve(otherAdminToken, ticket.id)).statusCode, 404);
    assert.strictEqual((await staffResolve(supBToken, ticket.id)).statusCode, 403);
    assert.strictEqual((await ticketNow(ticket.id)).status, 'IN_PROGRESS');

    const res = await staffResolve(supAToken, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.json().status, 'RESOLVED');
  });

  it('a public ticket resolved by the admin gets a guest review link that the guest can confirm (CLOSED)', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', source: 'PUBLIC' });
    const res = await staffResolve(adminToken, ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
    const token = tokenOf(res.json().reviewUrl);
    assert.strictEqual(token.length, 64);
    assert.strictEqual(res.json().reviewToken, undefined, 'the raw token is never in the response');

    assert.strictEqual((await guest('GET', token)).json().status, 'pending');
    const confirm = await guest('POST', token, { action: 'CONFIRM' });
    assert.strictEqual(confirm.statusCode, 200, confirm.body);
    assert.strictEqual((await ticketNow(ticket.id)).status, 'CLOSED');
  });

  // ── Electrician resolve → supervisor verify / reopen ──

  it('the electrician resolves with a photo → RESOLVED_PENDING_VERIFY, and the assigned supervisor is asked to verify', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });

    const noPhoto = await workerResolve(ticket.id, { note: 'x' }, null);
    assert.strictEqual(noPhoto.statusCode, 400);

    const res = await workerResolve(ticket.id);
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.json().status, 'RESOLVED_PENDING_VERIFY', 'an electrician never closes a ticket');
    assert.deepStrictEqual(res.json().resolvedWorkers.map((w) => w.id), [worker.id]);

    const ask = await eventually(() => prisma.notification.findFirst({ where: { userId: supA.id, entityId: ticket.id, type: 'ticket_pending_verify' } }));
    assert.ok(ask, 'the assigned supervisor got a verify request');
    assert.strictEqual(ask.isUrgent, true);
  });

  it('verify: another org 404, another supervisor 403, the assigned supervisor → RESOLVED with verifiedBy; verifying again is refused', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(ticket.id)).statusCode, 200);

    assert.strictEqual((await post(otherAdminToken, `/api/tickets/${ticket.id}/verify`)).statusCode, 404);
    assert.strictEqual((await post(supBToken, `/api/tickets/${ticket.id}/verify`)).statusCode, 403);
    assert.strictEqual((await ticketNow(ticket.id)).status, 'RESOLVED_PENDING_VERIFY');

    const res = await post(supAToken, `/api/tickets/${ticket.id}/verify`, { note: 'Checked on site' });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(res.json().status, 'RESOLVED');
    assert.strictEqual(res.json().verifiedBy.id, supA.id);
    assert.strictEqual(res.json().verifyNote, 'Checked on site');

    assert.strictEqual((await post(supAToken, `/api/tickets/${ticket.id}/verify`)).statusCode, 400);
  });

  it('reopen sends a pending-verify ticket back to IN_PROGRESS and clears the resolution', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(ticket.id)).statusCode, 200);

    assert.strictEqual((await post(supBToken, `/api/tickets/${ticket.id}/reopen`)).statusCode, 403);
    const res = await post(supAToken, `/api/tickets/${ticket.id}/reopen`, { note: 'Still flickering' });
    assert.strictEqual(res.statusCode, 200, res.body);
    const now = await ticketNow(ticket.id);
    assert.strictEqual(now.status, 'IN_PROGRESS');
    assert.strictEqual(now.resolvedImageUrl, null);
    assert.strictEqual(now.resolvedAt, null);
  });

  // ── Regressions ──

  it('BUG-0015: an electrician cannot resolve a ticket that is already verified or waiting for verification', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (const status of ['RESOLVED', 'RESOLVED_PENDING_VERIFY', 'CLOSED', 'CANCELLED']) {
      const ticket = await createTestTicket(org.id, location.id, { status, assignedToId: supA.id, verifiedAt: status === 'RESOLVED' ? new Date() : null, verifiedById: status === 'RESOLVED' ? supA.id : null });
      const res = await workerResolve(ticket.id);
      assert.strictEqual(res.statusCode, 400, `${status}: expected 400, got ${res.statusCode} ${res.body.slice(0, 100)}`);
      const now = await ticketNow(ticket.id);
      assert.strictEqual(now.status, status, `${status}: the status is unchanged`);
    }
    // Resolving straight from OPEN (no pickup first) stays allowed.
    const open = await createTestTicket(org.id, location.id, { status: 'OPEN' });
    assert.strictEqual((await workerResolve(open.id)).statusCode, 200);
  });

  it('BUG-0016: reopening a resolved public ticket withdraws its guest review, so the old link can no longer close it', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', source: 'PUBLIC' });
    const resolved = await staffResolve(adminToken, ticket.id);
    assert.strictEqual(resolved.statusCode, 200, resolved.body);
    const token = tokenOf(resolved.json().reviewUrl);

    const reopened = await app.inject({ method: 'PATCH', url: `/api/tickets/${ticket.id}`, headers: auth(adminToken), payload: { status: 'IN_PROGRESS' } });
    assert.strictEqual(reopened.statusCode, 200, reopened.body);

    const confirm = await guest('POST', token, { action: 'CONFIRM' });
    assert.notStrictEqual(confirm.statusCode, 200, 'the withdrawn review link must not be accepted');
    assert.strictEqual((await ticketNow(ticket.id)).status, 'IN_PROGRESS', 'the reopened ticket stays open');

    // The lazy auto-close of expired reviews (run on GET /tickets) must not close it either.
    const second = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', source: 'PUBLIC' });
    assert.strictEqual((await staffResolve(adminToken, second.id)).statusCode, 200);
    assert.strictEqual((await app.inject({ method: 'PATCH', url: `/api/tickets/${second.id}`, headers: auth(adminToken), payload: { status: 'IN_PROGRESS' } })).statusCode, 200);
    await prisma.ticket.updateMany({ where: { id: second.id, reviewToken: { not: null } }, data: { reviewExpiresAt: new Date(Date.now() - 60000) } });
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/tickets', headers: auth(adminToken) })).statusCode, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual((await ticketNow(second.id)).status, 'IN_PROGRESS', 'auto-close must not close a reopened ticket');
  });

  it('BUG-0017: after a guest rejects a resolution, the next verified resolution gets a fresh guest review', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', source: 'PUBLIC', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(ticket.id)).statusCode, 200);
    const first = await post(supAToken, `/api/tickets/${ticket.id}/verify`);
    assert.strictEqual(first.statusCode, 200, first.body);
    const firstToken = tokenOf(first.json().reviewUrl);
    assert.strictEqual(firstToken.length, 64);

    const reject = await guest('POST', firstToken, { action: 'REJECT', note: 'Still broken' });
    assert.strictEqual(reject.statusCode, 200, reject.body);
    assert.strictEqual((await ticketNow(ticket.id)).status, 'OPEN');

    assert.strictEqual((await workerResolve(ticket.id)).statusCode, 200);
    const second = await post(adminToken, `/api/tickets/${ticket.id}/verify`);
    assert.strictEqual(second.statusCode, 200, second.body);
    const secondToken = tokenOf(second.json().reviewUrl);
    assert.notStrictEqual(secondToken, firstToken, 'a new review link is issued');
    assert.strictEqual(secondToken.length, 64);
    const page = await guest('GET', secondToken);
    assert.strictEqual(page.json().status, 'pending', 'the guest can review the second fix');
  });

  it('BUG-0026: after a guest rejects the fix, the ticket is back in its electrician\'s pool and they are told why', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', source: 'PUBLIC', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(ticket.id)).statusCode, 200);
    const verified = await post(supAToken, `/api/tickets/${ticket.id}/verify`);
    assert.strictEqual(verified.statusCode, 200, verified.body);
    const reject = await guest('POST', tokenOf(verified.json().reviewUrl), { action: 'REJECT', note: 'Still dark in the corner' });
    assert.strictEqual(reject.statusCode, 200, reject.body);
    assert.strictEqual((await ticketNow(ticket.id)).status, 'OPEN');

    const pool = await app.inject({ method: 'GET', url: '/api/worker/tickets/pool', headers: auth(workerToken) });
    assert.strictEqual(pool.statusCode, 200);
    assert.ok(pool.json().tickets.some((x) => x.id === ticket.id), 'the rejected ticket is in the electrician\'s pool again');
    const told = await eventually(() => prisma.notification.findFirst({ where: { workerId: worker.id, entityId: ticket.id, type: 'ticket_review_rejected' } }));
    assert.ok(told, 'the electrician was told the guest rejected the fix');
    assert.match(told.body || '', /Still dark in the corner/);
    // The supervisor still sees the guest's verdict and note on the ticket.
    const now = await ticketNow(ticket.id);
    assert.strictEqual(now.reviewStatus, 'REJECTED');
    assert.strictEqual(now.reviewNote, 'Still dark in the corner');
  });

  it('BUG-0018: the electrician who resolved a ticket is told when it is verified, and when it is sent back', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const verified = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(verified.id)).statusCode, 200);
    assert.strictEqual((await post(supAToken, `/api/tickets/${verified.id}/verify`)).statusCode, 200);
    const told = await eventually(() => prisma.notification.findFirst({ where: { workerId: worker.id, entityId: verified.id, type: 'ticket_verified' } }));
    assert.ok(told, 'the electrician got a ticket_verified notification');

    const sentBack = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS', assignedToId: supA.id });
    assert.strictEqual((await workerResolve(sentBack.id)).statusCode, 200);
    assert.strictEqual((await post(supAToken, `/api/tickets/${sentBack.id}/reopen`, { note: 'Still flickering' })).statusCode, 200);
    const back = await eventually(() => prisma.notification.findFirst({ where: { workerId: worker.id, entityId: sentBack.id, type: 'ticket_reopened' } }));
    assert.ok(back, 'the electrician got a ticket_reopened notification');
    assert.match(back.body || '', /Still flickering/);

    // The worker's own notification list shows them.
    const list = await app.inject({ method: 'GET', url: '/api/worker/notifications', headers: auth(workerToken) });
    assert.strictEqual(list.statusCode, 200);
    const types = JSON.stringify(list.json());
    assert.match(types, /ticket_verified/);
    assert.match(types, /ticket_reopened/);
  });
});
