'use strict';

// Supervisors' Aadhaar number and blood group are personal data the Charter (§6) requires to
// be encrypted at rest through lib/crypto.js — as electricians' already were. They were stored
// in plain text, returned as stored, and copied into AuditLog as { from, to }. [BUG-0030]
// Also covers scripts/migrate-user-pii.js, which encrypts rows saved before the fix and
// removes those values from old audit rows.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const AADHAAR = '4321 8765 2109';
const AADHAAR_2 = '9988 7766 5544';
const BLOOD = 'AB-';

describe('BUG-0030: supervisor Aadhaar and blood group are encrypted at rest and kept out of audit rows', () => {
  let dbAvailable = false;
  let app, org, admin, token;
  const createdOrgIds = [];
  const auth = () => ({ authorization: `Bearer ${token}` });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.88.0.30' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    assert.strictEqual(login.statusCode, 200, login.body);
    token = login.json().token;
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  const createSupervisor = async (extra = {}) => {
    const res = await app.inject({
      method: 'POST', url: '/api/supervisors', headers: auth(),
      payload: { name: '__wp1_test__ PII Supervisor', email: `pii-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, password: 'Sup3rvisor!pass', aadharNo: AADHAAR, bloodGroup: BLOOD, ...extra }
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json();
  };

  it('create stores both fields encrypted; the admin reads them back in plain text', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const sup = await createSupervisor();

    const row = await prisma.user.findUnique({ where: { id: sup.id }, select: { aadharNo: true, bloodGroup: true } });
    assert.notStrictEqual(row.aadharNo, AADHAAR, 'the Aadhaar number is not stored as typed');
    assert.match(row.aadharNo, /^v1:/);
    assert.match(row.bloodGroup, /^v1:/);

    const detail = await app.inject({ method: 'GET', url: `/api/supervisors/${sup.id}`, headers: auth() });
    assert.strictEqual(detail.json().aadharNo, AADHAAR);
    assert.strictEqual(detail.json().bloodGroup, BLOOD);
    const list = await app.inject({ method: 'GET', url: '/api/supervisors?limit=100', headers: auth() });
    const listed = list.json().supervisors.find((s) => s.id === sup.id);
    assert.strictEqual(listed.aadharNo, AADHAAR);
    assert.strictEqual(listed.bloodGroup, BLOOD);
  });

  it('update stores the new number encrypted; the audit row says it changed but holds neither value', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const sup = await createSupervisor();
    const res = await app.inject({ method: 'PATCH', url: `/api/supervisors/${sup.id}`, headers: auth(), payload: { aadharNo: AADHAAR_2, bloodGroup: 'O+', designation: 'Warden' } });
    assert.strictEqual(res.statusCode, 200, res.body);

    const row = await prisma.user.findUnique({ where: { id: sup.id }, select: { aadharNo: true, bloodGroup: true } });
    assert.match(row.aadharNo, /^v1:/);
    const detail = await app.inject({ method: 'GET', url: `/api/supervisors/${sup.id}`, headers: auth() });
    assert.strictEqual(detail.json().aadharNo, AADHAAR_2);

    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, entityId: sup.id, action: 'supervisor_updated' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, 'the update is audited');
    const text = JSON.stringify(audit);
    for (const v of [AADHAAR, AADHAAR_2, BLOOD, 'O+']) assert.ok(!text.includes(v), `the audit row holds ${v}`);
    assert.deepStrictEqual(audit.newValue.aadharNo, { changed: true });
    assert.deepStrictEqual(audit.newValue.bloodGroup, { changed: true });
    assert.deepStrictEqual(audit.newValue.designation, { from: null, to: 'Warden' }, 'other fields keep their from/to');
  });

  it('a supervisor saved before the fix (plain text) still reads correctly, and an unchanged number is not re-audited', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const legacy = await createTestUser(org.id, { role: 'SUPERVISOR', aadharNo: AADHAAR, bloodGroup: BLOOD });
    const detail = await app.inject({ method: 'GET', url: `/api/supervisors/${legacy.id}`, headers: auth() });
    assert.strictEqual(detail.json().aadharNo, AADHAAR);
    const res = await app.inject({ method: 'PATCH', url: `/api/supervisors/${legacy.id}`, headers: auth(), payload: { aadharNo: AADHAAR, phone: '9000000030' } });
    assert.strictEqual(res.statusCode, 200, res.body);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, entityId: legacy.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(!('aadharNo' in audit.newValue), 'the same number typed again is not a change');
    assert.match((await prisma.user.findUnique({ where: { id: legacy.id } })).aadharNo, /^v1:/, 'saving encrypts it');
  });

  it('migrate-user-pii: a dry run changes nothing; --apply encrypts old rows and strips old audit values; a second run finds nothing', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { migrateUserPII } = require('../../scripts/migrate-user-pii');
    const legacy = await createTestUser(org.id, { role: 'SUPERVISOR', aadharNo: AADHAAR, bloodGroup: BLOOD });
    await prisma.auditLog.create({
      data: { orgId: org.id, actorType: 'admin', actorId: admin.id, action: 'supervisor_updated', entityType: 'User', entityId: legacy.id,
        oldValue: { name: legacy.name, email: legacy.email }, newValue: { aadharNo: { from: null, to: AADHAAR }, phone: { from: null, to: '9000000031' } } }
    });

    const dry = await migrateUserPII({ prisma, apply: false, orgIds: [org.id], log: () => {} });
    assert.ok(dry.usersToEncrypt >= 1 && dry.auditRowsToRedact >= 1, JSON.stringify(dry));
    assert.strictEqual((await prisma.user.findUnique({ where: { id: legacy.id } })).aadharNo, AADHAAR, 'a dry run writes nothing');

    const applied = await migrateUserPII({ prisma, apply: true, orgIds: [org.id], log: () => {} });
    assert.strictEqual(applied.usersEncrypted, dry.usersToEncrypt);
    assert.strictEqual(applied.auditRowsRedacted, dry.auditRowsToRedact);
    const row = await prisma.user.findUnique({ where: { id: legacy.id } });
    assert.match(row.aadharNo, /^v1:/);
    assert.match(row.bloodGroup, /^v1:/);
    const detail = await app.inject({ method: 'GET', url: `/api/supervisors/${legacy.id}`, headers: auth() });
    assert.strictEqual(detail.json().aadharNo, AADHAAR, 'the encrypted value still reads back');
    const audits = await prisma.auditLog.findMany({ where: { orgId: org.id, entityType: 'User' } });
    assert.ok(audits.every((a) => !JSON.stringify(a).includes(AADHAAR)), 'no audit row holds the number');
    const redacted = audits.find((a) => a.newValue && a.newValue.phone && a.newValue.phone.to === '9000000031');
    assert.deepStrictEqual(redacted.newValue.aadharNo, { changed: true });

    const again = await migrateUserPII({ prisma, apply: true, orgIds: [org.id], log: () => {} });
    assert.strictEqual(again.usersEncrypted, 0);
    assert.strictEqual(again.auditRowsRedacted, 0);
  });
});
