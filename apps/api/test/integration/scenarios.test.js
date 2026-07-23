'use strict';

// Regression tests for the scenario/seed system (apps/api/scenarios). [platform-M3]
//
// Proves the DPS §4/§5 guarantees that the seed platform must hold:
//   - every scenario is reproducible (the demo profile builds the expected state),
//   - demo data is deterministic (two seeds produce an identical fingerprint),
//   - the demo org is idempotent (find-or-create — never duplicated),
//   - a single scenario can be applied standalone.
//
// Runs the engine directly against the test database (same path tests already use).
// The migrate-reset half of `npm run reset` is a standard Prisma operation and is not
// exercised here (it would drop the whole DB mid-suite); the *seed* half — the part
// that determines reset's consistency — is validated directly below.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const engine = require('../../scenarios');
const demoOrg = require('../../scenarios/demo-organization');

async function fingerprint() {
  const org = await prisma.organization.findUnique({ where: { slug: engine.DEMO_SLUG } });
  if (!org) return null;
  const where = { where: { orgId: org.id } };
  const [users, workers, locations, tickets, inspections, notifications, attendance, insights] = await Promise.all([
    prisma.user.count(where), prisma.worker.count(where), prisma.location.count(where),
    prisma.ticket.count(where), prisma.electricalInspection.count(where),
    prisma.notification.count(where), prisma.attendance.count(where), prisma.aiInsight.count(where)
  ]);
  const admin = await prisma.user.findFirst({ where: { orgId: org.id, role: 'ADMIN' } });
  return { name: org.name, slug: org.slug, adminEmail: admin?.email, aiEnabled: org.aiEnabled,
    users, workers, locations, tickets, inspections, notifications, attendance, insights };
}

describe('platform-M3 — scenario & seed system', () => {
  let dbAvailable = false;

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await engine.clearDemo();
  });

  after(async () => {
    if (dbAvailable) await engine.clearDemo();
  });

  it('seed("demo") builds the expected demo organization and workflows', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await engine.seed('demo');
    const fp = await fingerprint();
    assert.ok(fp, 'demo org must exist after seed');
    assert.strictEqual(fp.name, 'Kodspot Demo');
    assert.strictEqual(fp.slug, engine.DEMO_SLUG);
    assert.strictEqual(fp.adminEmail, demoOrg.ADMIN_EMAIL);
    assert.strictEqual(fp.users, 3, '1 admin + 2 supervisors');
    assert.strictEqual(fp.workers, 3);
    assert.strictEqual(fp.locations, 3, '1 building + 2 rooms');
    assert.ok(fp.tickets >= 7, 'ticket-workflow tickets');
    assert.ok(fp.inspections >= 6, 'electrical (2) + reporting (4) inspections');
    assert.strictEqual(fp.notifications, 3);
    assert.strictEqual(fp.attendance, 21, '7 days x 3 workers');
    assert.strictEqual(fp.aiEnabled, true);
    assert.strictEqual(fp.insights, 1);
  });

  it('is deterministic — a second seed produces an identical fingerprint', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await engine.seed('demo');
    const fp1 = await fingerprint();
    await engine.seed('demo');
    const fp2 = await fingerprint();
    assert.deepStrictEqual(fp2, fp1, 'the demo dataset must be identical across seeds (reset consistency)');
  });

  it('demo-organization is idempotent — running it twice does not duplicate the org', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await engine.clearDemo();
    await engine.run('demo-organization');
    await engine.run('demo-organization');
    const count = await prisma.organization.count({ where: { slug: engine.DEMO_SLUG } });
    assert.strictEqual(count, 1, 'find-or-create must not create a second demo org');
  });

  it('a single scenario can be applied standalone (resolving its dependencies)', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await engine.clearDemo();
    await engine.run('admin-workflow'); // depends on demo-organization
    const org = await prisma.organization.findUnique({ where: { slug: engine.DEMO_SLUG } });
    assert.ok(org, 'the dependency (demo-organization) was applied automatically');
    const rules = await prisma.alertRule.count({ where: { orgId: org.id } });
    assert.ok(rules >= 1, 'admin-workflow created its alert rule');
  });

  it('exposes the full scenario catalog via list()', async () => {
    const names = engine.list().map((s) => s.name);
    for (const expected of ['fresh-installation', 'demo-organization', 'ticket-workflow',
      'electrical-workflow', 'attendance-workflow', 'notification-workflow', 'ai-workflow',
      'supervisor-workflow', 'worker-workflow', 'admin-workflow', 'reporting-workflow']) {
      assert.ok(names.includes(expected), `catalog must include ${expected}`);
    }
  });
});
