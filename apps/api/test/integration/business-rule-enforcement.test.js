'use strict';

// Database-backed regression tests for WP10 (Data Integrity & Business Rule
// Enforcement). Two gaps are locked in here:
//
// 1. tickets.js PATCH /tickets/:id (admin-only, generic status editor) could
//    set a ticket directly to RESOLVED_PENDING_VERIFY (a state that should
//    only be reached by a worker actually resolving the ticket), and moving
//    a resolved/verified ticket back to an active status left stale
//    resolvedImageUrl/verifiedAt/etc. fields in place, contradicting the new
//    status. Both are now enforced.
// 2. assets.js PATCH /assets/:id let an admin mark a FAULTY asset back to
//    OPERATIONAL/UNDER_MAINTENANCE by hand while it still had open
//    AssetFailure records, making the asset's own status lie about its
//    actual condition. Now rejected (409) unless the failures are resolved
//    first, or the asset is being decommissioned.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  createTestLocation,
  createTestTicket,
  createTestWorker,
  createTestAsset,
  createTestAssetFailure,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('WP10 — business rule enforcement', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let org, admin, tokenAdmin, location;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    org = await createTestOrg({ enabledModules: ['ele', 'asset'] });
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.plaintextPassword }
    });
    assert.strictEqual(loginRes.statusCode, 200, 'fixture login must succeed');
    tokenAdmin = loginRes.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('PATCH /tickets/:id rejects setting status to RESOLVED_PENDING_VERIFY directly', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ticket = await createTestTicket(org.id, location.id, { status: 'IN_PROGRESS' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'RESOLVED_PENDING_VERIFY' }
    });
    assert.strictEqual(res.statusCode, 400);

    const stored = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    assert.strictEqual(stored.status, 'IN_PROGRESS', 'the ticket must be unchanged');
  });

  it('PATCH /tickets/:id moving a RESOLVED ticket back to an active status clears stale resolution/verification fields', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const worker = await createTestWorker(org.id, { name: '__wp1_test__ Resolver' });
    const ticket = await createTestTicket(org.id, location.id, {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedImageUrl: 'https://example.test/proof.jpg',
      resolvedNote: '__wp1_test__ fixed it',
      verifiedAt: new Date(),
      verifiedById: admin.id,
      verifyNote: '__wp1_test__ confirmed',
      resolvedWorkers: { connect: [{ id: worker.id }] }
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'IN_PROGRESS' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().status, 'IN_PROGRESS');

    const stored = await prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { resolvedWorkers: true }
    });
    assert.strictEqual(stored.resolvedAt, null, 'resolvedAt must be cleared');
    assert.strictEqual(stored.resolvedImageUrl, null, 'resolvedImageUrl must be cleared');
    assert.strictEqual(stored.resolvedNote, null, 'resolvedNote must be cleared');
    assert.strictEqual(stored.verifiedAt, null, 'verifiedAt must be cleared');
    assert.strictEqual(stored.verifiedById, null, 'verifiedById must be cleared');
    assert.strictEqual(stored.verifyNote, null, 'verifyNote must be cleared');
    assert.strictEqual(stored.resolvedWorkers.length, 0, 'resolvedWorkers must be disconnected');
  });

  it('PATCH /tickets/:id moving to CLOSED preserves resolution fields (not treated as a reopen)', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const ticket = await createTestTicket(org.id, location.id, {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedImageUrl: 'https://example.test/proof2.jpg',
      resolvedNote: '__wp1_test__ done'
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'CLOSED' }
    });
    assert.strictEqual(res.statusCode, 200);

    const stored = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    assert.strictEqual(stored.status, 'CLOSED');
    assert.ok(stored.resolvedImageUrl, 'closing a resolved ticket must not wipe its resolution evidence');
  });

  it('PATCH /assets/:id rejects moving a FAULTY asset to OPERATIONAL while a failure is still open', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'FAULTY' });
    await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'OPEN' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${asset.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'OPERATIONAL' }
    });
    assert.strictEqual(res.statusCode, 409);

    const stored = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(stored.status, 'FAULTY', 'the asset must remain FAULTY while a failure is open');
  });

  it('PATCH /assets/:id allows decommissioning a FAULTY asset even with an open failure', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'FAULTY' });
    await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'OPEN' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${asset.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'DECOMMISSIONED' }
    });
    assert.strictEqual(res.statusCode, 200, 'decommissioning must not be blocked by open failures');
    assert.strictEqual(res.json().status, 'DECOMMISSIONED');
  });

  it('PATCH /assets/:id allows moving to OPERATIONAL once no failures remain open', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'FAULTY' });
    await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: admin.id });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${asset.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'OPERATIONAL' }
    });
    assert.strictEqual(res.statusCode, 200, 'no open failures remain, so the manual status change must be allowed');
    assert.strictEqual(res.json().status, 'OPERATIONAL');
  });
});
