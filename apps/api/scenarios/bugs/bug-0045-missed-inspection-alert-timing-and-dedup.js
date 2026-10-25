'use strict';

/**
 * BUG-0045 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestLocation } = require('../factories');

module.exports = {
  id: 'BUG-0045',
  title: 'Missed-inspection alerts: the night shift was checked during the night, and a second shift or a second rule never alerted',
  description: 'checkMissedInspections checked the NIGHT shift (22:00–06:00) from 22:00 to 06:00 — while it was running — so a "missed night inspection" fired minutes after the shift began, and after midnight a round done at 23:00 did not count (only today\'s inspections were read); nothing ran once the shift was over. fireAlert deduplicated on trigger + entity + day only, so a room that missed the morning and the afternoon got one alert, and of two rules on the same trigger only the first ever fired. Found by the 2026-10 product and architecture review (PAR-10/22) — the cross-rule part while fixing it.',
  module: 'ele',
  category: 'notification',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/22)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The NIGHT skip condition was inverted and its window was the calendar day; the dedup key had neither the rule nor the shift.',
  expectedBehavior: 'A shift is checked after it ends (NIGHT: from 06:00, against inspections since 22:00 the evening before); one alert per rule, entity, shift and day.',
  brokenBehavior: 'A NIGHT alert at 22:30; no NIGHT alert at 07:00; one alert for two missed shifts; the second rule silent.',
  reproductionSteps: [
    'Create two INSPECTION_MISSED rules and a room with no inspections.',
    'Run the scheduled checks at 23:00 and at 07:00 the next day (test/integration/missed-inspection.test.js mocks the clock).',
    'Broken: one alert, for the first rule, at 23:00 — partly the night shift. Fixed: morning and afternoon at 23:00 for each rule; night at 07:00.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/missed-inspection.test.js',

  async apply() {
    const { prisma } = require('../../src/lib/prisma');
    const org = await createTestOrg();
    const room = await createTestLocation(org.id);
    const rules = [];
    for (const name of ['__wp1_test__ BUG-0045 one', '__wp1_test__ BUG-0045 two']) {
      rules.push(await prisma.alertRule.create({ data: { orgId: org.id, name, trigger: 'INSPECTION_MISSED', conditions: {}, actions: [] } }));
    }
    return { org, room, rules };
  },

  // The dedup half, without a clock: two missed shifts for one room, two rules → four alerts.
  async validate(ctx) {
    const { org, room } = ctx['BUG-0045'];
    const { evaluateEvent } = require('../../src/services/automation');
    for (const shift of ['MORNING', 'AFTERNOON']) {
      await evaluateEvent('INSPECTION_MISSED', org.id, { entityType: 'location', entityId: room.id, locationId: room.id, locationName: room.name, shift, module: 'ele' });
    }
    const n = await ctx.prisma.alert.count({ where: { orgId: org.id, entityId: room.id } });
    if (n !== 4) return { ok: false, detail: `two missed shifts × two rules raised ${n} alert(s), expected 4` };
    return { ok: true, detail: 'one alert per rule and per missed shift' };
  }
};
