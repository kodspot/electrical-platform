'use strict';

// Database-backed integration test for ai.js (routes/ai.js).
//
// Decision on scope (see Work Package 7 instructions): every route in ai.js
// (/ai/status, /ai/suggestions, /ai/chat, /ai/analyze) derives its data
// exclusively from `request.user.orgId` — there is no id-based lookup of any
// other entity, and no request body field lets a client supply an orgId (the
// POST bodies only carry `message`/`type`). So there is no id-based
// "cross-org 404" surface to test here, unlike tickets/workers/etc.
//
// What *is* worth locking in with a real regression test: that the org-scoped
// AI configuration (aiEnabled/aiProvider/aiModel) returned by GET /ai/status is
// genuinely Org A's own config and never Org B's, proving `request.user.orgId`
// — not some shared/cached/mispartitioned value — drives the lookup. This is
// the one meaningful tenant-boundary assertion this file's routes support.
//
// Requires a reachable Postgres instance; skips cleanly if unavailable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestUser,
  cleanupTestOrgs
} = require('../helpers/db');

describe('tenant isolation — ai.js', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];

  let orgA, orgB, adminA, tokenA;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    app = await getTestApp();

    orgA = await createTestOrg({ aiEnabled: true, aiProvider: 'gemini', aiModel: 'gemini-2.0-flash' });
    orgB = await createTestOrg({ aiEnabled: true, aiProvider: 'azure-openai', aiModel: 'gpt-4o' });
    createdOrgIds.push(orgA.id, orgB.id);

    adminA = await createTestUser(orgA.id, { role: 'ADMIN' });

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

  it('GET /api/ai/status reflects Org A\'s own AI config, never Org B\'s', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/status',
      headers: { authorization: `Bearer ${tokenA}` }
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.provider, 'gemini', 'must reflect Org A\'s own provider');
    assert.notStrictEqual(body.provider, 'azure-openai', 'must never reflect Org B\'s provider');
    assert.strictEqual(body.model, 'gemini-2.0-flash');
  });
});
