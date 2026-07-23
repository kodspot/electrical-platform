'use strict';

/**
 * Scenario: Attendance Workflow. [platform-M3, DPS §4]
 * Attendance records for the last 7 days plus a duty roster.
 */

const { createTestAttendance, createTestDutyRoster } = require('./factories');

function dayAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d; }

async function apply(ctx) {
  const { org, workers, supervisors, rooms } = ctx['demo-organization'];
  const markedBy = supervisors[0].id;

  let count = 0;
  for (let d = 0; d < 7; d++) {
    for (let w = 0; w < workers.length; w++) {
      // Deterministic pattern: worker 0 is ABSENT two days ago, everyone else PRESENT.
      const status = (d === 2 && w === 0) ? 'ABSENT' : 'PRESENT';
      await createTestAttendance(org.id, workers[w].id, markedBy, { date: dayAgo(d), status, shift: 'MORNING' });
      count++;
    }
  }

  const roster = await createTestDutyRoster(org.id, rooms[0].id, supervisors[0].id, { date: dayAgo(0), shift: 'MORNING' });

  return { attendanceRecords: count, roster };
}

module.exports = {
  name: 'attendance-workflow',
  description: '7 days of attendance for all electricians (with one deterministic absence) + a duty roster.',
  dependsOn: ['demo-organization'],
  apply
};
