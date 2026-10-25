'use strict';

// Worker detail, create and update responses — org admin and super-admin — returned the whole
// Worker row: the PIN hash, a pending PIN-reset token (usable to set the electrician's PIN)
// and tokenInvalidBefore. Credential material never leaves the server. [BUG-0031]

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestWorker } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const CREDENTIAL_FIELDS = ['pinHash', 'resetToken', 'resetTokenExpiresAt', 'tokenInvalidBefore'];

describe('BUG-0031: worker responses never carry the PIN hash or a reset token', () => {
  let dbAvailable = false;
  let app, org, admin, superAdmin, adminAuth, saAuth, worker, resetToken;
  const createdOrgIds = [];
  let ip = 0;
  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `10.88.1.${++ip}` }, payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().token}` };
  };
  const assertNoCredentials = (name, res) => {
    assert.strictEqual(res.statusCode, 200, `${name}: ${res.body.slice(0, 120)}`);
    const body = res.json();
    for (const k of CREDENTIAL_FIELDS) assert.ok(!(k in body), `${name} returns ${k}`);
    assert.ok(!res.body.includes(resetToken), `${name} leaks the reset token`);
    assert.ok(!/\$2[aby]\$/.test(res.body), `${name} leaks a bcrypt hash`);
    return body;
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    superAdmin = await createTestUser(null, { role: 'SUPER_ADMIN' });
    adminAuth = await login(admin);
    saAuth = await login(superAdmin);
    resetToken = crypto.randomBytes(32).toString('hex');
    worker = await createTestWorker(org.id, { pin: '731731' });
    await prisma.worker.update({ where: { id: worker.id }, data: { resetToken, resetTokenExpiresAt: new Date(Date.now() + 3600000), tokenInvalidBefore: new Date() } });
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  });

  it('org admin: GET /workers/:id, POST /workers and PATCH /workers/:id', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const detail = assertNoCredentials('GET /workers/:id', await app.inject({ method: 'GET', url: `/api/workers/${worker.id}`, headers: adminAuth }));
    assert.strictEqual(detail.employeeId, worker.employeeId, 'the profile is still returned');

    const created = assertNoCredentials('POST /workers', await app.inject({ method: 'POST', url: '/api/workers', headers: adminAuth, payload: { name: '__wp1_test__ Cred New', employeeId: `CRED-${Date.now()}`, aadharNo: '2468 1357 9024' } }));
    assert.strictEqual(created.aadharNo, '2468 1357 9024', 'PII still reads back decrypted');

    const patched = assertNoCredentials('PATCH /workers/:id', await app.inject({ method: 'PATCH', url: `/api/workers/${worker.id}`, headers: adminAuth, payload: { designation: 'Senior Electrician' } }));
    assert.strictEqual(patched.designation, 'Senior Electrician');
  });

  it('super-admin: POST /superadmin/organizations/:orgId/workers and PATCH /superadmin/workers/:id', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const created = assertNoCredentials('SA POST worker', await app.inject({ method: 'POST', url: `/api/superadmin/organizations/${org.id}/workers`, headers: saAuth, payload: { name: '__wp1_test__ Cred SA', employeeId: `CRED-SA-${Date.now()}` } }));
    assert.ok(created.id);
    const patched = assertNoCredentials('SA PATCH worker', await app.inject({ method: 'PATCH', url: `/api/superadmin/workers/${worker.id}`, headers: saAuth, payload: { department: 'Maintenance' } }));
    assert.strictEqual(patched.department, 'Maintenance');
  });
});
