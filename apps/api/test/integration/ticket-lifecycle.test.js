'use strict';

// Database-backed integration test covering the ticket lifecycle happy path this far
// reachable without a real file upload to R2 (create → list → pickup → admin update).
// The /resolve and /verify steps require a mandatory proof-photo upload to object
// storage and are intentionally NOT covered here — see the Work Package Completion
// Report for why, and what would be needed to close that gap.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable (see
// test/helpers/db.js). Verified passing against a real Postgres instance.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  cleanupTestOrgs
} = require('../helpers/db');

describe('ticket lifecycle happy path', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let org, admin, supervisor, location, adminToken, supervisorToken;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    org = await createTestOrg();
    createdOrgIds.push(org.id);

    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    assert.strictEqual(adminLogin.statusCode, 200);
    adminToken = adminLogin.json().token;

    const supervisorLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: supervisor.email, password: supervisor.plaintextPassword }
    });
    assert.strictEqual(supervisorLogin.statusCode, 200);
    supervisorToken = supervisorLogin.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  let ticketId;

  it('an admin can create a ticket, which starts OPEN and unassigned', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { locationId: location.id, title: 'Flickering light in corridor', priority: 'HIGH' }
    });

    assert.strictEqual(res.statusCode, 200);
    const ticket = res.json();
    assert.strictEqual(ticket.status, 'OPEN');
    assert.strictEqual(ticket.priority, 'HIGH');
    assert.strictEqual(ticket.assignedToId ?? null, null, 'no SupervisorAssignment exists for this location, so it must stay unassigned');
    ticketId = ticket.id;
  });

  it('the new ticket appears in the admin\'s ticket list', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ids = res.json().tickets.map((tk) => tk.id);
    assert.ok(ids.includes(ticketId));
  });

  it('a supervisor can pick up the unassigned ticket, self-assigning and moving it to IN_PROGRESS', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/pickup`,
      headers: { authorization: `Bearer ${supervisorToken}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const ticket = res.json();
    assert.strictEqual(ticket.status, 'IN_PROGRESS');
    assert.strictEqual(ticket.assignedToId, supervisor.id);
  });

  it('a second pickup attempt on the now-assigned ticket fails', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/pickup`,
      headers: { authorization: `Bearer ${supervisorToken}` }
    });

    assert.strictEqual(res.statusCode, 404, 'a ticket that is no longer unassigned cannot be picked up again');
  });

  it('the assigned supervisor can accept-flow re-verify via GET, seeing it in their own list', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${supervisorToken}` }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().assignedToId, supervisor.id);
  });

  it('an admin can change ticket priority via PATCH', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { priority: 'URGENT' }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().priority, 'URGENT');
  });

  it('a supervisor (non-admin) cannot PATCH a ticket directly — ORG_ADMIN only', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${supervisorToken}` },
      payload: { priority: 'LOW' }
    });

    assert.strictEqual(res.statusCode, 403, 'PATCH /tickets/:id is gated to ORG_ADMIN per requirePolicy');
  });
});
