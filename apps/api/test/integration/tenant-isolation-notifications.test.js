'use strict';

// Database-backed integration tests proving notifications.js
// (routes/notifications.js) never leaks or lets a user mutate another org's
// (or another user's) Notification rows through the real HTTP API. Follows the
// exact pattern of test/integration/tenant-isolation.test.js (WP1, H1).
//
// Note: the authenticated list/read/delete routes in notifications.js scope
// every query by `userId: request.user.id` (not directly by orgId) — since user
// ids are globally unique, this is at least as strong a boundary as an orgId
// check. These tests confirm that boundary holds through the real HTTP API,
// using a notification created for Org B's own admin.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestNotification,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — notifications.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, adminB, notifA, notifB, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg();
    orgB = await createTestOrg();
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });
    adminB = await createTestUser(orgB.id, { role: 'ADMIN' });

    notifA = await createTestNotification(orgA.id, { userId: adminA.id, title: '__wp1_test__ Notif A' });
    notifB = await createTestNotification(orgB.id, { userId: adminB.id, title: '__wp1_test__ Notif B' });

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

  it('GET /api/notifications never returns another org\'s (or another user\'s) notification', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().notifications.map((n) => n.id);
    assert.ok(ids.includes(notifA.id), 'Admin A\'s own notification must be visible');
    assert.ok(!ids.includes(notifB.id), 'Org B\'s notification must never appear in Admin A\'s list');
  });

  it('PATCH /api/notifications/:id/read returns 404 (not 200 or 403) for another org\'s notification', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${notifB.id}/read`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('DELETE /api/notifications/:id returns 404 (not 200 or 403) for another org\'s notification', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/notifications/${notifB.id}`,
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /api/notifications/unread-count never counts another org\'s notification', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications/unread-count',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    // Admin A has exactly one unread notification of their own (notifA).
    assert.strictEqual(res.json().count, 1, 'unread count must not include Org B\'s notification');
  });
});
