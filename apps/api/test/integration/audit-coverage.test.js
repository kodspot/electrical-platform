'use strict';

// Actions that left no audit row (PAR-10/13): signing in, changing or resetting a password or
// PIN, the super admin's bootstrap, inspection templates, duty rosters, attendance edits,
// alert-rule edits, acknowledging alerts, running the alert checks by hand, and creating a
// ticket. Each now writes one, naming who did it. [BUG-0058]
//
// Failed sign-ins are still not audited: anyone can cause them, so rows would let them fill
// the table. That is an owner decision.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestWorker, createTestAlert } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { hashResetToken } = require('../../src/lib/security');
const { localDateKey } = require('../../src/lib/dates');

describe('BUG-0058: the actions that left no audit row now write one', () => {
  let dbAvailable = false;
  let app, org, admin, supervisor, location, worker;
  let adminAuth, supAuth;
  const createdOrgIds = [];
  let ip = 0;
  const nextIp = () => `10.88.58.${++ip}`;
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const login = async (user, password = user.plaintextPassword) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': nextIp() }, payload: { email: user.email, password } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json().token;
  };
  const call = async (method, url, headers, payload, expected = [200, 201]) => {
    const res = await app.inject({ method, url, headers, payload });
    assert.ok(expected.includes(res.statusCode), `${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.statusCode === 204 ? {} : res.json();
  };
  const audited = async (action, where = {}) => {
    const row = await prisma.auditLog.findFirst({ where: { action, ...where }, orderBy: { createdAt: 'desc' } });
    assert.ok(row, `no "${action}" audit row for ${JSON.stringify(where)}`);
    return row;
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    location = await createTestLocation(org.id);
    worker = await createTestWorker(org.id, { pin: '585858' });
    adminAuth = bearer(await login(admin));
    supAuth = bearer(await login(supervisor));
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('signing in, changing a password, resetting one', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const row = await audited('signed_in', { orgId: org.id, actorId: admin.id });
    assert.strictEqual(row.actorType, 'admin');
    await audited('signed_in', { orgId: org.id, actorId: supervisor.id, actorType: 'supervisor' });

    const user = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const token = await login(user);
    await call('PATCH', '/api/auth/password', bearer(token), { currentPassword: user.plaintextPassword, newPassword: 'Changed1234' });
    await audited('password_changed', { orgId: org.id, actorId: user.id });

    const reset = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({ where: { id: user.id }, data: { resetToken: hashResetToken(reset), resetTokenExpiresAt: new Date(Date.now() + 3600000) } });
    await app.inject({ method: 'POST', url: '/api/auth/reset-password', headers: { 'x-forwarded-for': nextIp() }, payload: { token: reset, newPassword: 'ResetAgain123' } })
      .then((res) => assert.strictEqual(res.statusCode, 200, res.body));
    await audited('password_reset', { orgId: org.id, actorId: user.id });
  });

  it('an electrician signing in, changing a PIN, resetting one', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const wl = await app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': nextIp() }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '585858' } });
    assert.strictEqual(wl.statusCode, 200, wl.body);
    await audited('signed_in', { orgId: org.id, actorId: worker.id, actorType: 'worker' });
    await call('PATCH', '/api/auth/worker-pin', bearer(wl.json().token), { currentPin: '585858', newPin: '595959' });
    await audited('pin_changed', { orgId: org.id, actorId: worker.id, actorType: 'worker' });

    const reset = crypto.randomBytes(32).toString('hex');
    await prisma.worker.update({ where: { id: worker.id }, data: { resetToken: hashResetToken(reset), resetTokenExpiresAt: new Date(Date.now() + 3600000) } });
    await app.inject({ method: 'POST', url: '/api/auth/worker-reset-pin', headers: { 'x-forwarded-for': nextIp() }, payload: { token: reset, newPin: '606060' } })
      .then((res) => assert.strictEqual(res.statusCode, 200, res.body));
    await audited('pin_reset', { orgId: org.id, actorId: worker.id });
  });

  it('inspection templates: create, edit, duplicate, delete', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const name = `__wp1_test__ Template ${Date.now()}`;
    const tpl = await call('POST', '/api/inspection-templates', adminAuth, { name, items: [{ label: 'Wiring', checkKey: 'WIRING' }] });
    await audited('template_created', { orgId: org.id, actorId: admin.id, entityId: tpl.id });
    await call('PATCH', `/api/inspection-templates/${tpl.id}`, adminAuth, { description: 'Edited' });
    await audited('template_updated', { orgId: org.id, entityId: tpl.id });
    const copy = await call('POST', `/api/inspection-templates/${tpl.id}/duplicate`, adminAuth, {});
    await audited('template_duplicated', { orgId: org.id, entityId: copy.id });
    await call('DELETE', `/api/inspection-templates/${copy.id}`, adminAuth);
    await audited('template_deleted', { orgId: org.id, entityId: copy.id });
  });

  it('duty rosters: start, change the location, change the electricians, remove', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const other = await createTestLocation(org.id);
    const roster = await call('POST', '/api/duty-roster', supAuth, { date: localDateKey(), shift: 'GENERAL', locationId: location.id });
    const by = { orgId: org.id, actorId: supervisor.id, actorType: 'supervisor', entityId: roster.id };
    await audited('roster_created', by);
    await call('PATCH', `/api/duty-roster/${roster.id}`, supAuth, { locationId: other.id });
    await audited('roster_location_changed', by);
    await call('PUT', `/api/duty-roster/${roster.id}/workers`, supAuth, { workerIds: [worker.id] });
    await audited('roster_workers_changed', by);
    await call('DELETE', `/api/duty-roster/${roster.id}`, supAuth);
    await audited('roster_deleted', by);
  });

  it('an attendance record edited', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await call('POST', '/api/attendance/bulk', supAuth, { date: localDateKey(), shift: 'MORNING', records: [{ workerId: worker.id, status: 'PRESENT' }] });
    const record = await prisma.attendance.findFirst({ where: { orgId: org.id, workerId: worker.id, shift: 'MORNING' } });
    await call('PATCH', `/api/attendance/${record.id}`, supAuth, { status: 'HALF_DAY' });
    const row = await audited('attendance_updated', { orgId: org.id, actorId: supervisor.id, entityId: record.id });
    assert.deepStrictEqual(row.oldValue, { status: 'PRESENT', note: null });
  });

  it('alert rules edited, alerts acknowledged, the checks run by hand', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const rule = await call('POST', '/api/alert-rules', adminAuth, { name: '__wp1_test__ Rule', trigger: 'TICKET_HIGH_PRIORITY', conditions: {}, actions: [{ type: 'NOTIFY_ADMINS' }] });
    await call('PATCH', `/api/alert-rules/${rule.id}`, adminAuth, { name: '__wp1_test__ Rule edited' });
    await audited('alert_rule_updated', { orgId: org.id, actorId: admin.id, entityId: rule.id });
    const one = await createTestAlert(org.id);
    await call('PATCH', `/api/alerts/${one.id}/acknowledge`, adminAuth);
    await audited('alert_acknowledged', { orgId: org.id, entityId: one.id });
    await createTestAlert(org.id);
    await call('PATCH', '/api/alerts/acknowledge-all', adminAuth);
    const all = await audited('alerts_acknowledged', { orgId: org.id, actorId: admin.id });
    assert.deepStrictEqual(all.newValue, { count: 1 });
    await call('POST', '/api/alerts/run-checks', adminAuth);
    await audited('alert_checks_run', { orgId: org.id, actorId: admin.id });
    await call('POST', '/api/alerts/run-escalations', adminAuth);
    await audited('alert_escalations_run', { orgId: org.id, actorId: admin.id });
  });

  it('a ticket raised by staff', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const ticket = await call('POST', '/api/tickets', adminAuth, { locationId: location.id, title: '__wp1_test__ Sparking socket', priority: 'NORMAL' });
    const row = await audited('ticket_created', { orgId: org.id, actorId: admin.id, entityId: ticket.id });
    assert.strictEqual(row.actorType, 'admin');
  });
});
