'use strict';

// SCHEDULED_CHECKS → missed-inspection alerts (services/automation.js), at chosen times of day
// (only Date is mocked). Three defects: [BUG-0045]
//   - the NIGHT shift (22:00–06:00) was checked DURING the night — at 22:30 a "missed night
//     inspection" fired for a shift that had just begun — and only against today's
//     inspections, so one done at 23:00 did not count after midnight; nothing ran after the
//     shift ended;
//   - the alert dedup key ignored the shift: a location that missed the morning AND the
//     afternoon round got one alert;
//   - it ignored the rule too: of two rules on the same trigger, only the first ever fired.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestLocation, createTestElectricalInspection } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { runScheduledChecks } = require('../../src/services/automation');

const quiet = { info() {}, warn() {}, error() {} };
/** Local time `hour`:`minute` on today + `dayOffset`. */
const at = (dayOffset, hour, minute = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(hour, minute, 0, 0); return d; };

describe('BUG-0045: missed-inspection alerts — after each shift ends, once per shift and per rule', () => {
  let dbAvailable = false;
  let org, supervisor, roomA, roomB, ruleOne, ruleTwo;
  const createdOrgIds = [];
  const alerts = (room, shift, rule) => prisma.alert.count({ where: { orgId: org.id, entityId: room.id, title: { endsWith: `(${shift})` }, ...(rule ? { ruleId: rule.id } : {}) } });
  const checkAt = async (t, when) => {
    t.mock.timers.enable({ apis: ['Date'], now: when });
    try { await runScheduledChecks(quiet, { orgId: org.id }); } finally { t.mock.timers.reset(); }
  };

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    supervisor = await createTestUser(org.id, { role: 'SUPERVISOR' });
    roomA = await createTestLocation(org.id);
    roomB = await createTestLocation(org.id);
    const rule = (name) => prisma.alertRule.create({ data: { orgId: org.id, name, trigger: 'INSPECTION_MISSED', conditions: {}, actions: [] } });
    ruleOne = await rule('__wp1_test__ missed — notify');
    ruleTwo = await rule('__wp1_test__ missed — second rule');
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('at 23:00 the missed morning and afternoon rounds are raised — each once, by each rule — and the night shift, just begun, is not', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await checkAt(t, at(0, 23));
    for (const rule of [ruleOne, ruleTwo]) {
      assert.strictEqual(await alerts(roomA, 'MORNING', rule), 1, `MORNING, ${rule.name}`);
      assert.strictEqual(await alerts(roomA, 'AFTERNOON', rule), 1, `AFTERNOON, ${rule.name}`);
    }
    assert.strictEqual(await alerts(roomA, 'NIGHT'), 0, 'the night shift has only just started');
  });

  it('at 07:00 the next day, a night round done at 23:30 counts, and a room nobody inspected overnight is raised', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    await createTestElectricalInspection(org.id, roomA.id, supervisor.id, { shift: 'NIGHT', inspectedAt: at(0, 23, 30) });
    await checkAt(t, at(1, 7));
    assert.strictEqual(await alerts(roomA, 'NIGHT'), 0, 'room A was inspected during the night shift');
    assert.strictEqual(await alerts(roomB, 'NIGHT', ruleOne), 1, 'room B missed the night round');
    assert.strictEqual(await alerts(roomB, 'MORNING', ruleOne), 1, 'nothing new for the morning shift still running — only yesterday\'s');
  });
});
