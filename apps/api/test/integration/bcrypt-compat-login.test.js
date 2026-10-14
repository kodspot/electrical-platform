'use strict';

// bcrypt 5 → 6 at the API level: a user whose stored passwordHash was produced by bcrypt 5.1.1
// (before the upgrade) still signs in, and a wrong password is still refused.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

// bcrypt 5.1.1, cost 10, of 'Kodspot-Compat-Pass1' (see test/bcrypt-compat.test.js).
const BCRYPT5_HASH = '$2b$10$rKlIb.MsmICXppMdBhbrCOq6g5j0AUeEscBDMqydKf.eFNYUdMaBi';

describe('bcrypt 6 — a password stored by bcrypt 5 still signs in', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  let user;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    const org = await createTestOrg();
    createdOrgIds.push(org.id);
    user = await createTestUser(org.id, { role: 'ADMIN' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: BCRYPT5_HASH } });
  });

  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('POST /api/auth/login: 200 with the right password, 401 with a wrong one', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.96.0.1' }, payload: { email: user.email, password: 'Kodspot-Compat-Pass1' } });
    assert.strictEqual(ok.statusCode, 200, ok.body.slice(0, 160));
    assert.ok(ok.json().token);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.96.0.2' }, payload: { email: user.email, password: 'Kodspot-Compat-Pass2' } });
    assert.strictEqual(bad.statusCode, 401);
  });
});
