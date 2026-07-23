'use strict';

/**
 * Scenario: Reporting Workflow. [platform-M3, DPS §4]
 * Dated historical spread so analytics and reporting views have data over time:
 * a weekly inspection going back four weeks.
 */

const { createTestElectricalInspection } = require('./factories');

function weeksAgo(n) { const d = new Date(); d.setDate(d.getDate() - n * 7); return d; }

async function apply(ctx) {
  const { org, rooms, supervisors, workers } = ctx['demo-organization'];

  let count = 0;
  for (let w = 1; w <= 4; w++) {
    await createTestElectricalInspection(org.id, rooms[w % rooms.length].id, supervisors[0].id, {
      shift: 'MORNING', status: 'SUBMITTED', inspectedAt: weeksAgo(w),
      items: { create: [{ checkType: 'LIGHTING', status: 'OK' }, { checkType: 'FAN', status: 'OK' }] },
      workers: { connect: [{ id: workers[w % workers.length].id }] }
    });
    count++;
  }

  return { historicalInspections: count };
}

module.exports = {
  name: 'reporting-workflow',
  description: 'Four weeks of historical inspections so analytics/reporting views have trend data.',
  dependsOn: ['demo-organization'],
  apply
};
