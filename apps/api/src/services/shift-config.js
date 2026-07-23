'use strict';

/**
 * Shared shift-window configuration. [WP10]
 *
 * Extracted from routes/electrical.js, where this logic previously lived as
 * local closures used only by the inspection-submission route. automation.js
 * needs the same per-org shift windows for its missed-inspection alerting
 * (previously hardcoded there instead of reading ShiftConfig), so this is
 * now a standalone module both callers share rather than each keeping (or
 * duplicating) their own copy.
 */

const { prisma } = require('../lib/prisma');

const DEFAULT_SHIFTS = {
  MORNING:   { startHour: 6, startMin: 0, endHour: 14, endMin: 0 },
  AFTERNOON: { startHour: 14, startMin: 0, endHour: 22, endMin: 0 },
  NIGHT:     { startHour: 22, startMin: 0, endHour: 6, endMin: 0 },
  GENERAL:   { startHour: 0, startMin: 0, endHour: 0, endMin: 0 }
};

const _shiftCache = {};

async function getShiftConfigs(orgId) {
  const cached = _shiftCache[orgId];
  if (cached && Date.now() - cached.ts < 300000) return cached.data;
  const rows = await prisma.shiftConfig.findMany({ where: { orgId } });
  const configs = { ...DEFAULT_SHIFTS };
  for (const r of rows) {
    configs[r.shift] = { startHour: r.startHour, startMin: r.startMin, endHour: r.endHour, endMin: r.endMin };
  }
  _shiftCache[orgId] = { data: configs, ts: Date.now() };
  return configs;
}

function timeInMinutes(h, m) { return h * 60 + m; }

function getExpectedShiftFromConfig(configs) {
  const now = new Date();
  const nowMins = timeInMinutes(now.getHours(), now.getMinutes());
  for (const shift of ['MORNING', 'AFTERNOON', 'NIGHT']) {
    const c = configs[shift];
    const start = timeInMinutes(c.startHour, c.startMin);
    const end = timeInMinutes(c.endHour, c.endMin);
    if (end > start) {
      if (nowMins >= start && nowMins < end) return shift;
    } else if (end < start) {
      if (nowMins >= start || nowMins < end) return shift;
    }
  }
  return 'GENERAL';
}

function isWithinShiftWindowConfig(shift, configs) {
  if (shift === 'GENERAL') return true;
  return shift === getExpectedShiftFromConfig(configs);
}

function hasShiftStarted(shift, configs) {
  if (shift === 'GENERAL') return true;
  const c = configs[shift];
  if (!c) return true;
  const now = new Date();
  const nowMins = timeInMinutes(now.getHours(), now.getMinutes());
  const startMins = timeInMinutes(c.startHour, c.startMin);
  const endMins = timeInMinutes(c.endHour, c.endMin);
  if (endMins > startMins) {
    return nowMins >= startMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}

module.exports = {
  DEFAULT_SHIFTS,
  getShiftConfigs,
  timeInMinutes,
  getExpectedShiftFromConfig,
  isWithinShiftWindowConfig,
  hasShiftStarted
};
