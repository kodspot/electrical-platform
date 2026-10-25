'use strict';

// WP-H F4: a failing notification step on ticket creation is logged once at warn —
// still fire-and-forget (the request succeeds), but no longer silent. This file replaces
// assignment-resolver exports BEFORE the app loads (routes destructure them at require
// time), so it must stay its own file: node:test runs each file in its own process.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const resolver = require('../../src/services/assignment-resolver');
const realSupervisorLookup = resolver.getAssignedSupervisorIds;
let failSupervisorLookup = false;
resolver.getAssignedWorkerIds = async () => { throw new Error('stubbed worker lookup failure'); };
resolver.getAssignedSupervisorIds = async (...args) => {
  if (failSupervisorLookup) throw new Error('stubbed supervisor lookup failure');
  return realSupervisorLookup(...args);
};

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');

const { buildApp, registerApp } = require('../../index');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation } = require('../helpers/db');

function captureStream() {
  const lines = [];
  return {
    stream: new Writable({ write(chunk, _e, cb) { lines.push(...chunk.toString().split('\n').filter(Boolean)); cb(); } }),
    warns: () => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'notification step failed')
  };
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

describe('WP-H F4 — failed notification steps are logged, never silent', () => {
  let dbAvailable = false;
  let app;
  let logs;
  const createdOrgIds = [];
  let org, admin, location;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    logs = captureStream();
    app = buildApp({ logger: { level: 'warn', stream: logs.stream } });
    await registerApp(app);
    await app.ready();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    location = await createTestLocation(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await app.close();
  });

  it('public complaint: the electrician-ring step fails → 200 and exactly one warn line', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const res = await app.inject({
      method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': '10.88.0.1' },
      payload: { locationId: location.id, issueType: 'LIGHT_NOT_WORKING', guestName: 'Guest With Email', guestPhone: '9999999999', consent: true }
    });
    assert.strictEqual(res.statusCode, 200);
    const ticketId = res.json().ticket.id;
    await waitFor(() => logs.warns().some((w) => w.ticketId === ticketId));
    const warns = logs.warns().filter((w) => w.ticketId === ticketId);
    assert.strictEqual(warns.length, 1, JSON.stringify(warns));
    assert.strictEqual(warns[0].step, 'notify_workers');
    assert.strictEqual(warns[0].err, 'stubbed worker lookup failure');
    const line = JSON.stringify(warns[0]);
    assert.ok(!/https?:\/\/|token|@/i.test(line), 'a warn line must carry no URL, token or email');
  });

  it('internal ticket: the supervisor lookup fails → 200, unassigned, and exactly one warn line', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: admin.email, password: admin.plaintextPassword } });
    const token = loginRes.json().token;
    failSupervisorLookup = true;
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/tickets', headers: { authorization: `Bearer ${token}` },
        payload: { locationId: location.id, title: '__wp1_test__ F4 ticket' }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json().assignedToId, null);
      const ticketId = res.json().id;
      await waitFor(() => logs.warns().some((w) => w.ticketId === ticketId));
      const warns = logs.warns().filter((w) => w.ticketId === ticketId);
      assert.strictEqual(warns.length, 1, JSON.stringify(warns));
      assert.strictEqual(warns[0].step, 'resolve_supervisors');
    } finally {
      failSupervisorLookup = false;
    }
  });
});
