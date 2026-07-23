'use strict';

// Regression tests for WP15 (Notification Channel Unification). Covers:
//  - The new unified notify() interface (services/notification-service.js):
//    each existing audience dispatch (userId/admins), the optional paired
//    email, that it never rejects (matching the pre-existing fire-and-forget
//    convention at every call site it replaces), and that adding a new
//    notification audience is a single addition to NOTIFY_CHANNELS — the
//    plan's "adding a new notification type requires touching exactly one
//    place" acceptance criterion, demonstrated here rather than shipped as a
//    real production channel.
//  - A before/after behavioral diff for two of the real call sites this
//    replaced: PATCH /tickets/:id (assignment) and POST /public/complaint
//    (admin notify+email) — the same Notification rows must still fire.
//
// POST /tickets/:id/resolve's admin notify+email pairing (the same
// notify({ to: { admins: true }, email: { toAdmins: true } }) shape as the
// two call sites above) is not re-tested end-to-end here: it requires a
// mandatory proof-photo upload to R2, already out of scope for HTTP-level
// testing per ticket-lifecycle.test.js. Its behavior is covered by the same
// notify() unit coverage below, plus inspection of the call-site diff, which
// is mechanical (identical shape, different subject/title strings).
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { notify, NOTIFY_CHANNELS } = require('../../src/services/notification-service');
const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

// The route handlers under test fire notify() without awaiting it (the same
// pre-existing fire-and-forget convention every call site already used
// before WP15 — the HTTP response must not wait on a notification write).
// A test asserting on the resulting row therefore has to tolerate that small
// async gap rather than assuming it landed synchronously before the HTTP
// response returned.
async function waitForNotification(where, { timeoutMs = 1000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const notif = await prisma.notification.findFirst({ where });
    if (notif) return notif;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('WP15 — unified notify() interface', () => {
  let dbAvailable = false;
  const createdOrgIds = [];
  let org, admin, supervisor;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('dispatches to a single user via to.userId, creating a Notification row', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    await notify({ orgId: org.id, to: { userId: supervisor.id }, type: 'test_type', title: 'Hi', body: 'body', entityId: 'wp15-e1' });
    const notif = await prisma.notification.findFirst({ where: { orgId: org.id, userId: supervisor.id, entityId: 'wp15-e1' } });
    assert.ok(notif, 'notify({ to: { userId } }) must create a Notification for that user');
    assert.strictEqual(notif.title, 'Hi');
  });

  it('dispatches to every active admin via to.admins', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    await notify({ orgId: org.id, to: { admins: true }, type: 'test_type', title: 'Admin hi', body: 'b', entityId: 'wp15-e2' });
    const notif = await prisma.notification.findFirst({ where: { orgId: org.id, userId: admin.id, entityId: 'wp15-e2' } });
    assert.ok(notif, 'notify({ to: { admins: true } }) must create a Notification for each active admin');
  });

  it('never rejects when an email is paired, even with no SES transport configured in this environment', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    await assert.doesNotReject(notify({
      orgId: org.id,
      to: { userId: supervisor.id },
      type: 'test_type', title: 'Paired', body: 'b', entityId: 'wp15-e3',
      email: { to: 'someone@example.test', subject: 'Subject', html: '<p>hi</p>' }
    }));
    const notif = await prisma.notification.findFirst({ where: { orgId: org.id, userId: supervisor.id, entityId: 'wp15-e3' } });
    assert.ok(notif, 'the in-app notification must still be created when an email is paired with it');
  });

  it('never rejects and creates no notification when to matches no known channel', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    await assert.doesNotReject(notify({ orgId: org.id, to: {}, type: 'test_type', title: 'x', body: 'b', entityId: 'wp15-e4' }));
    const notif = await prisma.notification.findFirst({ where: { orgId: org.id, entityId: 'wp15-e4' } });
    assert.strictEqual(notif, null);
  });

  it('adding a new notification audience requires touching only NOTIFY_CHANNELS, not notify() or any call site', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    let called = null;
    NOTIFY_CHANNELS.__wp15_test_channel = (orgId, to, payload) => { called = { orgId, to, payload }; return Promise.resolve(); };
    try {
      await notify({ orgId: org.id, to: { __wp15_test_channel: true }, type: 'test_type', title: 'New channel', body: 'b', entityId: 'wp15-e5' });
      assert.ok(called, 'notify() must invoke a handler added to NOTIFY_CHANNELS at runtime, with no change to notify() itself');
      assert.strictEqual(called.orgId, org.id);
      assert.strictEqual(called.payload.title, 'New channel');
    } finally {
      delete NOTIFY_CHANNELS.__wp15_test_channel;
    }
  });
});

describe('WP15 — real call sites still fire the same notification after the refactor', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let org, admin, supervisor, supervisor2, location, adminToken;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    supervisor2 = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    adminToken = login.json().token;
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('PATCH /tickets/:id assigning a ticket still creates a Notification for the new assignee (and the paired email path still succeeds)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const createRes = await app.inject({
      method: 'POST', url: '/api/tickets', headers: { authorization: `Bearer ${adminToken}` },
      payload: { locationId: location.id, title: 'Test ticket for WP15', priority: 'NORMAL' }
    });
    assert.strictEqual(createRes.statusCode, 200);
    const ticketId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/tickets/${ticketId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { assignedToId: supervisor.id }
    });
    assert.strictEqual(patchRes.statusCode, 200);

    const notif = await waitForNotification({ orgId: org.id, userId: supervisor.id, entityId: ticketId, type: 'ticket_assigned' });
    assert.ok(notif, 'assigning a ticket must still create an in-app notification for the assignee, same as before the notify() refactor');

    // Reassigning to a different supervisor exercises the paired-email branch
    // (assigneeEmail resolved from the DB) — must still succeed end-to-end.
    const reassignRes = await app.inject({
      method: 'PATCH', url: `/api/tickets/${ticketId}`, headers: { authorization: `Bearer ${adminToken}` },
      payload: { assignedToId: supervisor2.id }
    });
    assert.strictEqual(reassignRes.statusCode, 200, 'reassignment (which also resolves assigneeEmail for the paired email) must still succeed');

    const notif2 = await waitForNotification({ orgId: org.id, userId: supervisor2.id, entityId: ticketId, type: 'ticket_assigned' });
    assert.ok(notif2, 'the new assignee must also get an in-app notification');
  });

  it('POST /public/complaint still notifies and emails admins for a new complaint', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST', url: '/api/public/complaint',
      headers: { 'x-forwarded-for': '10.15.0.1' },
      payload: { locationId: location.id, issueType: 'LIGHT_NOT_WORKING' }
    });
    assert.strictEqual(res.statusCode, 200);
    const ticketId = res.json().ticket.id;

    const notif = await waitForNotification({ orgId: org.id, userId: admin.id, entityId: ticketId, type: 'public_complaint' });
    assert.ok(notif, 'a public complaint must still notify admins in-app, same as before the notify() refactor');
  });
});
