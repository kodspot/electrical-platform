'use strict';

// Database-backed regression tests for WP9 (Workflow Integrity & Transaction
// Safety, Audit finding H5). Two things are being proven here:
//
// 1. Rollback: a multi-write handler that fails partway through must leave
//    ZERO trace of the writes that already ran — not just the one that threw.
//    This is exercised for real (not simulated) by racing two concurrent
//    POST /assets requests with the same assetCode: Postgres's own unique
//    constraint rejects the loser inside the $transaction, so the loser's
//    AssetEvent/AuditLog writes must never have landed either.
// 2. Consistency: every handler touched in WP9 (assets create/update/delete,
//    asset-events, asset-failures create/resolve/reopen, ticket auto-assign)
//    now writes its dependent records together — this locks that in so a
//    future edit can't reintroduce a partial-write gap silently.
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
  createTestAsset,
  createTestAssetFailure,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('WP9 — workflow integrity & transaction safety', () => {
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

  it('a losing request in a duplicate-assetCode race leaves zero trace — no orphaned AssetEvent or AuditLog', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const assetCode = '__wp1_test__-race-' + Date.now();
    const payload = {
      assetCode,
      name: '__wp1_test__ Race Asset',
      category: 'Panel',
      locationId: location.id
    };

    const eventsBefore = await prisma.assetEvent.count({ where: { orgId: org.id } });
    const auditBefore = await prisma.auditLog.count({ where: { orgId: org.id, action: 'asset_created' } });

    // Two concurrent creates with the SAME assetCode: the pre-check
    // (findFirst for a dup code) can't prevent this TOCTOU race by itself —
    // it's the transaction's own unique-constraint failure that must roll
    // back cleanly for the loser.
    const [resA, resB] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/assets', headers: { authorization: `Bearer ${tokenAdmin}` }, payload }),
      app.inject({ method: 'POST', url: '/api/assets', headers: { authorization: `Bearer ${tokenAdmin}` }, payload })
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    assert.deepStrictEqual(statuses, [201, 409], 'exactly one request must succeed and the other must be rejected as a duplicate');

    // Exactly one Asset with this code — the DB-level unique constraint held.
    const assets = await prisma.asset.findMany({ where: { orgId: org.id, assetCode } });
    assert.strictEqual(assets.length, 1, 'only one asset with this code may exist');

    // Exactly one new AssetEvent (the winner's INSTALLED event) — if the
    // loser's transaction had partially committed, there would be two.
    const eventsAfter = await prisma.assetEvent.count({ where: { orgId: org.id } });
    assert.strictEqual(eventsAfter, eventsBefore + 1, 'the losing transaction must not leave an orphaned AssetEvent');

    // Exactly one new asset_created audit entry, for the same reason.
    const auditAfter = await prisma.auditLog.count({ where: { orgId: org.id, action: 'asset_created' } });
    assert.strictEqual(auditAfter, auditBefore + 1, 'the losing transaction must not leave an orphaned AuditLog entry');
  });

  it('POST /assets creates the asset and its INSTALLED event together', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { assetCode: '__wp1_test__-create-' + Date.now(), name: '__wp1_test__ Create Asset', category: 'Panel', locationId: location.id }
    });
    assert.strictEqual(res.statusCode, 201);
    const asset = res.json();

    const event = await prisma.assetEvent.findFirst({ where: { assetId: asset.id, type: 'INSTALLED' } });
    assert.ok(event, 'the INSTALLED event must exist alongside the new asset');
  });

  it('PATCH /assets/:id creates a matching event when status changes', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'OPERATIONAL' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/assets/${asset.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'UNDER_MAINTENANCE' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().status, 'UNDER_MAINTENANCE');

    const event = await prisma.assetEvent.findFirst({
      where: { assetId: asset.id, statusAfter: 'UNDER_MAINTENANCE' },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(event, 'a status-change event must exist alongside the updated asset');
  });

  it('DELETE /assets/:id (soft-deactivate path) updates the asset and logs the event together', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'OPERATIONAL' });
    // Give it 2 events so the route takes the soft-deactivate branch (>1 event).
    await prisma.assetEvent.createMany({
      data: [
        { orgId: org.id, assetId: asset.id, loggedById: admin.id, type: 'INSPECTED', summary: '__wp1_test__ e1' },
        { orgId: org.id, assetId: asset.id, loggedById: admin.id, type: 'INSPECTED', summary: '__wp1_test__ e2' }
      ]
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/assets/${asset.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.json().message, /decommissioned/i);

    const updated = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(updated.isActive, false);
    assert.strictEqual(updated.status, 'DECOMMISSIONED');

    const event = await prisma.assetEvent.findFirst({ where: { assetId: asset.id, type: 'DECOMMISSIONED' } });
    assert.ok(event, 'a DECOMMISSIONED event must exist alongside the deactivated asset');
  });

  it('POST /asset-events updates the parent asset\'s status together with the event', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'UNDER_MAINTENANCE' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/asset-events',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { assetId: asset.id, type: 'REPAIRED', summary: '__wp1_test__ repaired', statusAfter: 'OPERATIONAL' }
    });
    assert.strictEqual(res.statusCode, 201);

    const updated = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(updated.status, 'OPERATIONAL', 'the asset\'s own status must reflect the logged event');
  });

  it('POST /asset-failures marks the asset FAULTY and logs the event together', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'OPERATIONAL' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/asset-failures',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { assetId: asset.id, title: '__wp1_test__ Failure', severity: 'HIGH' }
    });
    assert.strictEqual(res.statusCode, 201);

    const updated = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(updated.status, 'FAULTY', 'the asset must be FAULTY, matching the reported failure');

    const event = await prisma.assetEvent.findFirst({ where: { assetId: asset.id, statusAfter: 'FAULTY' } });
    assert.ok(event, 'a timeline event must exist alongside the reported failure');
  });

  it('PATCH /asset-failures/:id (resolve) sets the asset back to OPERATIONAL only when no other failures remain', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'FAULTY' });
    const failure = await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'OPEN' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/asset-failures/${failure.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'RESOLVED', resolution: '__wp1_test__ fixed it' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().status, 'RESOLVED');

    const updatedAsset = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(updatedAsset.status, 'OPERATIONAL', 'the asset must not be left stuck on FAULTY once its only failure is resolved');

    const event = await prisma.assetEvent.findFirst({ where: { assetId: asset.id, type: 'REPAIRED' } });
    assert.ok(event, 'a REPAIRED event must exist alongside the resolved failure');
  });

  it('PATCH /asset-failures/:id (resolve) leaves the asset FAULTY when another failure is still open', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const asset = await createTestAsset(org.id, location.id, { status: 'FAULTY' });
    const failureA = await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'OPEN', title: '__wp1_test__ A' });
    await createTestAssetFailure(org.id, asset.id, admin.id, { status: 'OPEN', title: '__wp1_test__ B (stays open)' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/asset-failures/${failureA.id}`,
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { status: 'RESOLVED' }
    });
    assert.strictEqual(res.statusCode, 200);

    const updatedAsset = await prisma.asset.findUnique({ where: { id: asset.id } });
    assert.strictEqual(updatedAsset.status, 'FAULTY', 'the asset must stay FAULTY while a sibling failure is still open');
  });

  it('POST /tickets auto-assigns to the covering supervisor in the same write as creation', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await prisma.supervisorAssignment.create({
      data: { orgId: org.id, supervisorId: supervisor.id, locationId: location.id, coverChildren: true }
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { authorization: `Bearer ${tokenAdmin}` },
      payload: { locationId: location.id, title: '__wp1_test__ Auto-assign ticket' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json().assignedToId, supervisor.id, 'the ticket must already be assigned in the create response, not require a follow-up read');

    const stored = await prisma.ticket.findUnique({ where: { id: res.json().id } });
    assert.strictEqual(stored.assignedToId, supervisor.id);
  });
});
