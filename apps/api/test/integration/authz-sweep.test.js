'use strict';

// Authorization sweep over every mutating staff route that takes a record id (the
// "mutations by bare id are preceded by an orgId-scoped ownership check" rule, Charter §6.1):
// org B's admin (and supervisor, for the supervisor-only routes) calls each one with a real
// org A record and a VALID body, so the ownership check — not input validation — decides.
// Every one must answer 404 (never 403, never 2xx) and leave org A's record as it was.
// Also: role boundaries (electrician → staff routes, supervisor → admin routes, admin →
// super-admin routes), a suspended organization, a disabled module, and the public
// complaint route's module check (BUG-0020).

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { getTestApp } = require('../helpers/build-app');
const f = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
function imageBody() {
  const boundary = '----sweep' + crypto.randomUUID().replace(/-/g, '');
  return {
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`), PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

describe('authorization sweep — cross-org mutations, role boundaries, suspended org, disabled module', () => {
  let dbAvailable = false;
  let app;
  const createdOrgIds = [];
  const A = {};
  let adminB, supB, adminBToken, supBToken, locationB;
  let ip = 0;
  const xff = () => ({ 'x-forwarded-for': `10.55.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });

  const login = async (user) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: xff(), payload: { email: user.email, password: user.plaintextPassword } });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json().token;
  };

  before(async () => {
    dbAvailable = await f.isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();

    // Org A owns every record; both orgs have the asset module, so requireModule('asset')
    // passes for org B and only the ownership check is left to answer.
    const orgA = await f.createTestOrg({ enabledModules: ['ele', 'asset'] });
    const orgB = await f.createTestOrg({ enabledModules: ['ele', 'asset'] });
    createdOrgIds.push(orgA.id, orgB.id);
    A.org = orgA;
    A.admin = await f.createTestUser(orgA.id, { role: 'ADMIN' });
    A.supervisor = await f.createTestUser(orgA.id, { role: 'SUPERVISOR' });
    A.location = await f.createTestLocation(orgA.id);
    A.worker = await f.createTestWorker(orgA.id);
    A.ticket = await f.createTestTicket(orgA.id, A.location.id, { status: 'OPEN' });
    A.pendingTicket = await f.createTestTicket(orgA.id, A.location.id, { status: 'RESOLVED_PENDING_VERIFY', assignedToId: A.supervisor.id });
    A.rule = await f.createTestAlertRule(orgA.id);
    A.alert = await f.createTestAlert(orgA.id, { ruleId: A.rule.id });
    A.asset = await f.createTestAsset(orgA.id, A.location.id);
    A.failure = await f.createTestAssetFailure(orgA.id, A.asset.id, A.admin.id);
    A.attendance = await f.createTestAttendance(orgA.id, A.worker.id, A.supervisor.id);
    A.category = await f.createTestComplaintCategory(orgA.id);
    A.roster = await f.createTestDutyRoster(orgA.id, A.location.id, A.supervisor.id);
    A.template = await f.createTestInspectionTemplate(orgA.id);
    A.inspection = await f.createTestElectricalInspection(orgA.id, A.location.id, A.supervisor.id);

    adminB = await f.createTestUser(orgB.id, { role: 'ADMIN' });
    supB = await f.createTestUser(orgB.id, { role: 'SUPERVISOR' });
    locationB = await f.createTestLocation(orgB.id);
    adminBToken = await login(adminB);
    supBToken = await login(supB);
  });

  after(async () => {
    if (!dbAvailable) return;
    await f.cleanupTestOrgs(createdOrgIds);
  });

  it('every id-taking mutation answers 404 for another org\'s record, and changes nothing', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const json = (payload) => ({ payload });
    // [method, url, body, token?] — a VALID body for each route, so validation passes.
    const cases = [
      ['DELETE', `/api/alert-rules/${A.rule.id}`],
      ['DELETE', `/api/assets/${A.asset.id}/images/${crypto.randomUUID()}`],
      ['DELETE', `/api/assets/${A.asset.id}`],
      ['DELETE', `/api/complaint-categories/${A.category.id}`],
      ['DELETE', `/api/duty-roster/${A.roster.id}`],
      ['DELETE', `/api/inspection-templates/${A.template.id}`],
      ['DELETE', `/api/locations/${A.location.id}`],
      ['DELETE', `/api/supervisors/${A.supervisor.id}`],
      ['DELETE', `/api/supervisors/${A.supervisor.id}/permanent`],
      ['DELETE', `/api/workers/${A.worker.id}`],
      ['DELETE', `/api/workers/${A.worker.id}/permanent`],
      ['PATCH', `/api/alert-rules/${A.rule.id}`, json({ name: 'Taken over' })],
      ['PATCH', `/api/alerts/${A.alert.id}/acknowledge`],
      ['PATCH', `/api/asset-failures/${A.failure.id}`, json({ status: 'IN_PROGRESS' })],
      ['PATCH', `/api/assets/${A.asset.id}`, json({ name: 'Taken over' })],
      ['PATCH', `/api/attendance/${A.attendance.id}`, json({ status: 'ABSENT' })],
      ['PATCH', `/api/complaint-categories/${A.category.id}`, json({ isActive: false })],
      ['PATCH', `/api/duty-roster/${A.roster.id}`, json({ locationId: locationB.id })],
      ['PATCH', `/api/electrical-inspections/${A.inspection.id}/flag`, json({ reason: 'Taken over' })],
      ['PATCH', `/api/inspection-templates/${A.template.id}`, json({ isActive: false })],
      ['PATCH', `/api/locations/${A.location.id}`, json({ name: 'Taken over' })],
      ['PATCH', `/api/supervisors/${A.supervisor.id}`, json({ name: 'Taken over' })],
      ['PATCH', `/api/supervisors/${A.supervisor.id}/password`, json({ password: 'TakenOver123!' })],
      ['PATCH', `/api/tickets/${A.ticket.id}`, json({ priority: 'LOW' })],
      ['PATCH', `/api/workers/${A.worker.id}`, json({ name: 'Taken over' })],
      ['PATCH', `/api/workers/${A.worker.id}/pin`, json({ pin: '135790' })],
      ['POST', `/api/asset-failures/${A.failure.id}/images`, imageBody()],
      ['POST', `/api/assets/${A.asset.id}/images`, imageBody()],
      ['POST', `/api/inspection-templates/${A.template.id}/duplicate`],
      ['POST', `/api/tickets/${A.ticket.id}/accept`, undefined, 'sup'],
      ['POST', `/api/tickets/${A.ticket.id}/pickup`, undefined, 'sup'],
      ['POST', `/api/tickets/${A.pendingTicket.id}/reopen`, json({})],
      ['POST', `/api/tickets/${A.ticket.id}/resolve`, imageBody()],
      ['POST', `/api/tickets/${A.pendingTicket.id}/verify`, json({})],
      ['PUT', `/api/duty-roster/${A.roster.id}/workers`, json({ workerIds: [] })],
      ['PUT', `/api/supervisors/${A.supervisor.id}/assignments`, json({ locationIds: [locationB.id] })],
      ['PUT', `/api/workers/${A.worker.id}/assignments`, json({ locationIds: [locationB.id] })]
    ];
    const wrong = [];
    for (const [method, url, body = {}, who] of cases) {
      const token = who === 'sup' ? supBToken : adminBToken;
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(body.headers || {}) }, payload: body.payload });
      if (res.statusCode !== 404) wrong.push(`${method} ${url.replace(/[0-9a-f-]{36}/g, ':id')} → ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    assert.deepStrictEqual(wrong, [], 'every cross-org mutation answers 404');

    // Nothing of org A's changed.
    const [rule, ticket, location, supervisor, worker, asset, alert] = await Promise.all([
      prisma.alertRule.findUnique({ where: { id: A.rule.id } }),
      prisma.ticket.findUnique({ where: { id: A.ticket.id } }),
      prisma.location.findUnique({ where: { id: A.location.id } }),
      prisma.user.findUnique({ where: { id: A.supervisor.id } }),
      prisma.worker.findUnique({ where: { id: A.worker.id } }),
      prisma.asset.findUnique({ where: { id: A.asset.id } }),
      prisma.alert.findUnique({ where: { id: A.alert.id } })
    ]);
    assert.strictEqual(rule.name, A.rule.name);
    assert.strictEqual(ticket.priority, 'NORMAL');
    assert.strictEqual(ticket.status, 'OPEN');
    assert.strictEqual(location.isActive, true);
    assert.strictEqual(supervisor.isActive, true);
    assert.strictEqual(worker.isActive, true);
    assert.strictEqual(asset.name, A.asset.name);
    assert.strictEqual(alert.acknowledged, false);
  });

  it('role boundaries: an electrician token on staff routes 401, a supervisor on admin routes 403, an admin on super-admin routes 403', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const worker = await f.createTestWorker(A.org.id, { pin: '642531' });
    const wl = await app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: xff(), payload: { orgSlug: A.org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    assert.strictEqual(wl.statusCode, 200, wl.body);
    const elec = { authorization: `Bearer ${wl.json().token}` };
    for (const [method, url] of [['GET', '/api/tickets'], ['POST', '/api/tickets'], ['PATCH', `/api/tickets/${A.ticket.id}`], ['POST', '/api/workers'], ['GET', '/api/superadmin/organizations']]) {
      const res = await app.inject({ method, url, headers: elec, payload: {} });
      assert.strictEqual(res.statusCode, 401, `electrician ${method} ${url}`);
    }

    const supA = { authorization: `Bearer ${await login(A.supervisor)}` };
    const adminOnly = [
      ['PATCH', `/api/tickets/${A.ticket.id}`, { priority: 'LOW' }],
      ['POST', '/api/workers', { name: 'Sneaky', employeeId: 'SNEAK-1' }],
      ['PATCH', `/api/workers/${A.worker.id}/pin`, { pin: '135790' }],
      ['POST', '/api/supervisors', { name: 'Sneaky', email: 'sneaky@example.test', password: 'Sneaky123!' }],
      ['POST', '/api/alert-rules', { name: 'Sneaky', trigger: 'TICKET_HIGH_PRIORITY', actions: [{ type: 'NOTIFY_ADMINS' }] }],
      ['DELETE', `/api/locations/${A.location.id}`]
    ];
    for (const [method, url, payload] of adminOnly) {
      const res = await app.inject({ method, url, headers: supA, payload });
      assert.strictEqual(res.statusCode, 403, `supervisor ${method} ${url}: ${res.body.slice(0, 80)}`);
    }

    const adminA = { authorization: `Bearer ${await login(A.admin)}` };
    for (const [method, url] of [['GET', '/api/superadmin/organizations'], ['POST', '/api/superadmin/organizations'], ['PATCH', `/api/superadmin/organizations/${A.org.id}`]]) {
      const res = await app.inject({ method, url, headers: adminA, payload: { name: 'x' } });
      assert.strictEqual(res.statusCode, 403, `admin ${method} ${url}`);
    }
  });

  it('a suspended organization: its staff and electrician sessions are refused, and its QR page takes no complaints', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const org = await f.createTestOrg();
    createdOrgIds.push(org.id);
    const admin = await f.createTestUser(org.id, { role: 'ADMIN' });
    const worker = await f.createTestWorker(org.id, { pin: '753159' });
    const room = await f.createTestLocation(org.id, { qrCode: 'SUSP' + crypto.randomUUID().slice(0, 6).toUpperCase() });
    await f.createTestWorkerAssignment(org.id, worker.id, room.id);
    const staff = { authorization: `Bearer ${await login(admin)}` };
    const wl = await app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: xff(), payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    assert.strictEqual(wl.statusCode, 200);
    const elec = { authorization: `Bearer ${wl.json().token}` };

    await prisma.organization.update({ where: { id: org.id }, data: { status: 'SUSPENDED' } });
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/tickets', headers: staff })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/workers', headers: staff, payload: { name: 'X', employeeId: 'X-1' } })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/worker/tickets', headers: elec })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'GET', url: `/api/public/location/${room.qrCode}`, headers: xff() })).statusCode, 410);
    const complaint = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: xff(), payload: { locationId: room.id, issueType: 'LIGHT_NOT_WORKING' } });
    assert.strictEqual(complaint.statusCode, 410);
    assert.strictEqual(await prisma.ticket.count({ where: { orgId: org.id } }), 0);
  });

  it('a disabled module: its routes answer 403 and no ticket can be raised in it', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const org = await f.createTestOrg({ enabledModules: ['ele'] });
    createdOrgIds.push(org.id);
    const admin = await f.createTestUser(org.id, { role: 'ADMIN' });
    const room = await f.createTestLocation(org.id);
    const staff = { authorization: `Bearer ${await login(admin)}` };
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/assets', headers: staff })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/asset-failures', headers: staff, payload: { assetId: crypto.randomUUID(), title: 'x', severity: 'LOW' } })).statusCode, 403);
    const ticket = await app.inject({ method: 'POST', url: '/api/tickets', headers: staff, payload: { locationId: room.id, title: 'Cracked wall', module: 'civil' } });
    assert.strictEqual(ticket.statusCode, 403);
    assert.strictEqual(await prisma.ticket.count({ where: { orgId: org.id } }), 0);
  });

  it('BUG-0020: a guest complaint for a module the organization has not enabled is refused', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const org = await f.createTestOrg({ enabledModules: ['ele'] });
    createdOrgIds.push(org.id);
    const room = await f.createTestLocation(org.id);
    const res = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: xff(), payload: { locationId: room.id, issueType: 'PLUMBING_LEAK', module: 'civil' } });
    assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode} ${res.body.slice(0, 100)}`);
    assert.strictEqual(await prisma.ticket.count({ where: { orgId: org.id } }), 0, 'no ticket in a module the org does not have');
    // The enabled module still works.
    const ok = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: xff(), payload: { locationId: room.id, issueType: 'LIGHT_NOT_WORKING', module: 'ele' } });
    assert.strictEqual(ok.statusCode, 200, ok.body);
  });
});
