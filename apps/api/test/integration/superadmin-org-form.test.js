'use strict';

// The super-admin "New Organization" / "Edit" form, at the API level, with the exact body the
// dashboard sends (superadmin-dashboard.html: empty Phone / Email / Address are sent as '').
// BUG-0023: creating an organization without an email answered 400 "Validation failed".

const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestUser } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

describe('super-admin organization form → POST/PATCH /api/superadmin/organizations', () => {
  let dbAvailable = false;
  let app, sa, auth;
  const createdOrgIds = [];

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    sa = await createTestUser(null, { role: 'SUPER_ADMIN' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.44.0.1' }, payload: { email: sa.email, password: sa.plaintextPassword } });
    assert.strictEqual(login.statusCode, 200, login.body);
    auth = { authorization: `Bearer ${login.json().token}` };
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    await prisma.user.deleteMany({ where: { id: sa.id } });
  });

  const formBody = (overrides = {}) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    return { name: `__wp1_test__ Form Org ${suffix}`, slug: `wp1-form-org-${suffix}`, type: 'HOSPITAL', enabledModules: ['ele'], phone: '', email: '', address: '', ...overrides };
  };

  it('BUG-0023: an organization can be created with the optional contact fields left empty', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const res = await app.inject({ method: 'POST', url: '/api/superadmin/organizations', headers: auth, payload: formBody() });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode} ${res.body.slice(0, 160)}`);
    const org = res.json().organization || res.json();
    createdOrgIds.push(org.id);
    const row = await prisma.organization.findUnique({ where: { id: org.id } });
    assert.strictEqual(row.email, null, 'an empty email is stored as no email');
    assert.deepStrictEqual(row.enabledModules, ['ele']);
  });

  it('a real email is kept; an invalid one, or a taken slug, is refused', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ok = await app.inject({ method: 'POST', url: '/api/superadmin/organizations', headers: auth, payload: formBody({ email: 'facilities@example.test' }) });
    assert.strictEqual(ok.statusCode, 200, ok.body);
    const org = ok.json().organization || ok.json();
    createdOrgIds.push(org.id);
    assert.strictEqual((await prisma.organization.findUnique({ where: { id: org.id } })).email, 'facilities@example.test');

    const bad = await app.inject({ method: 'POST', url: '/api/superadmin/organizations', headers: auth, payload: formBody({ email: 'not-an-email' }) });
    assert.strictEqual(bad.statusCode, 400);
    const taken = await app.inject({ method: 'POST', url: '/api/superadmin/organizations', headers: auth, payload: formBody({ slug: org.slug }) });
    assert.ok([400, 409].includes(taken.statusCode), `a taken slug answered ${taken.statusCode}`);

    // Edit with the same form body: renaming, and clearing the email.
    const edit = await app.inject({ method: 'PATCH', url: `/api/superadmin/organizations/${org.id}`, headers: auth, payload: { name: `${org.name} renamed`, type: 'HOSPITAL', enabledModules: ['ele'], phone: '', email: '', address: '', status: 'ACTIVE' } });
    assert.strictEqual(edit.statusCode, 200, edit.body);
    const after = await prisma.organization.findUnique({ where: { id: org.id } });
    assert.strictEqual(after.name, `${org.name} renamed`);
    assert.strictEqual(after.email, null);
  });
});
