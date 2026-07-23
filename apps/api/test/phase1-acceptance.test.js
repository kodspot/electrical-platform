'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  POLICY_DEFINITIONS,
  MODULE_CODES,
  getPermissionPolicy
} = require('../src/middleware/permission-policy');
const {
  attachTenantContextFromUser,
  attachTenantContextFromWorker,
  getTenantOrgId
} = require('../src/middleware/tenant-context');

test('permission policy contract', () => {
  const requiredPolicies = [
    'SUPER_ADMIN',
    'ORG_ADMIN',
    'ORG_STAFF',
    'SUPERVISOR',
    'ADMIN_OR_SUPER_ADMIN'
  ];

  for (const name of requiredPolicies) {
    const policy = getPermissionPolicy(name);
    assert(policy, `Missing policy ${name}`);
    assert(Array.isArray(policy.roles) && policy.roles.length > 0, `Policy ${name} must define roles`);
  }

  assert.strictEqual(MODULE_CODES.ELE, 'ele', 'ELE module code mismatch');
  assert.strictEqual(MODULE_CODES.ASSET, 'asset', 'ASSET module code mismatch');
  assert.strictEqual(POLICY_DEFINITIONS.ORG_STAFF.requireOrgContext, true, 'ORG_STAFF should require org context');

  assert.throws(() => getPermissionPolicy('UNKNOWN_POLICY'), 'Unknown policy lookup should throw');
});

test('tenant context propagation contract', () => {
  const reqUser = {};
  const user = { id: 'u1', orgId: 'o1', role: 'ADMIN' };
  const userTenant = attachTenantContextFromUser(reqUser, user);

  assert.strictEqual(userTenant.actorType, 'user', 'User tenant actorType mismatch');
  assert.strictEqual(userTenant.actorId, 'u1', 'User tenant actorId mismatch');
  assert.strictEqual(userTenant.orgId, 'o1', 'User tenant orgId mismatch');
  assert.strictEqual(getTenantOrgId(reqUser), 'o1', 'User tenant org resolver mismatch');

  const reqWorker = {};
  const worker = { id: 'w1', orgId: 'o2' };
  const workerTenant = attachTenantContextFromWorker(reqWorker, worker);

  assert.strictEqual(workerTenant.actorType, 'worker', 'Worker tenant actorType mismatch');
  assert.strictEqual(workerTenant.role, 'WORKER', 'Worker tenant role mismatch');
  assert.strictEqual(workerTenant.orgId, 'o2', 'Worker tenant orgId mismatch');
  assert.strictEqual(getTenantOrgId(reqWorker), 'o2', 'Worker tenant org resolver mismatch');
});

test('route guard coverage standardization', () => {
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));

  const allowLegacyRoleGuard = new Set([
    'worker-auth.js',
    'public.js',
    'pages.js',
    'images.js',
    'health.js'
  ]);

  const policyExpectedFiles = new Set([
    'ai.js',
    'alerts.js',
    'analytics.js',
    'asset-events.js',
    'asset-failures.js',
    'assets.js',
    'attendance.js',
    'audit-logs.js',
    'auth.js',
    'duty-roster.js',
    'electrical.js',
    'locations.js',
    'notifications.js',
    'predictions.js',
    'superadmin.js',
    'supervisors.js',
    'templates.js',
    'tickets.js',
    'workers.js'
  ]);

  for (const file of files) {
    const fullPath = path.join(routesDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    if (!allowLegacyRoleGuard.has(file)) {
      assert(!content.includes('requireRole('), `${file} still uses requireRole`);
    }

    if (policyExpectedFiles.has(file)) {
      assert(content.includes('requirePolicy('), `${file} does not use requirePolicy`);
    }
  }

  const authMiddleware = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
  const workerAuthRoute = fs.readFileSync(path.join(routesDir, 'worker-auth.js'), 'utf8');

  assert(authMiddleware.includes('attachTenantContextFromUser(request, user);'), 'User tenant context is not attached in auth middleware');
  assert(workerAuthRoute.includes('attachTenantContextFromWorker(request, worker);'), 'Worker tenant context is not attached in worker auth route');
});
