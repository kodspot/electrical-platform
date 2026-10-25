'use strict';

const { prisma } = require('../lib/prisma');
const { runExclusive, LOCK_KEYS } = require('../lib/scheduler-lock');
const { resolveAiCredentials, callAiProvider } = require('../lib/ai-provider');
const { getShiftConfigs } = require('./shift-config');
const {
  createNotification,
  notifyAdmins,
  notifySupervisors,
  notifySupervisorIds,
  notifyWorkers
} = require('./notification-service');
const { pushAlert } = require('./sse');
const { getAssignedWorkerIds, getAssignedSupervisorIds, getLocationBreadcrumb } = require('./assignment-resolver');
const { normalizeEnabledModules, isModuleEnabled } = require('./module-policy');
const { ACTIVE_TICKET_STATUSES, TICKET_PRIORITIES, getSlaDeadline } = require('./ticket-status');

// ── Severity ordinals ──
const SEV_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const PRI_ORDER = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const ALERT_SEV_MAP = { LOW: 'INFO', MEDIUM: 'WARNING', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

// ─────────────────────────────────────────────
// EVENT-DRIVEN EVALUATION
// Called inline by route handlers (fire-and-forget)
// ─────────────────────────────────────────────

async function evaluateEvent(trigger, orgId, data, logger) {
  try {
    const rules = await prisma.alertRule.findMany({
      where: { orgId, trigger, isActive: true }
    });
    for (const rule of rules) {
      if (!matchesConditions(trigger, rule.conditions, data)) continue;
      await fireAlert(rule, orgId, trigger, data, logger);
    }
  } catch (err) {
    if (logger) logger.error({ err, trigger, orgId }, 'Alert evaluation failed');
  }
}

function matchesConditions(trigger, cond, data) {
  switch (trigger) {
    case 'INSPECTION_FAULT':
      return data.faultyCount >= (cond.minFaults || 1);
    case 'INSPECTION_LATE':
      return true;
    case 'ASSET_FAILURE_REPORTED': {
      const min = SEV_ORDER.indexOf(cond.minSeverity || 'LOW');
      return SEV_ORDER.indexOf(data.severity || 'MEDIUM') >= min;
    }
    case 'TICKET_HIGH_PRIORITY': {
      const min = PRI_ORDER.indexOf(cond.minPriority || 'HIGH');
      return PRI_ORDER.indexOf(data.priority || 'NORMAL') >= min;
    }
    // Scheduled triggers always match at evaluation time
    case 'INSPECTION_MISSED':
    case 'ASSET_FAILURE_UNRESOLVED':
    case 'ASSET_MAINTENANCE_OVERDUE':
    case 'ATTENDANCE_LOW':
      return true;
    default:
      return false;
  }
}

function deriveSeverity(trigger, data) {
  switch (trigger) {
    case 'INSPECTION_FAULT':
      return data.faultyCount >= 5 ? 'CRITICAL' : data.faultyCount >= 3 ? 'HIGH' : 'WARNING';
    case 'INSPECTION_LATE':
      return 'WARNING';
    case 'INSPECTION_MISSED':
      return 'HIGH';
    case 'ASSET_FAILURE_REPORTED':
      return ALERT_SEV_MAP[data.severity] || 'WARNING';
    case 'ASSET_FAILURE_UNRESOLVED':
      return 'HIGH';
    case 'ASSET_MAINTENANCE_OVERDUE':
      return 'WARNING';
    case 'TICKET_HIGH_PRIORITY':
      return data.priority === 'URGENT' ? 'CRITICAL' : 'HIGH';
    case 'ATTENDANCE_LOW':
      return 'WARNING';
    default:
      return 'WARNING';
  }
}

async function fireAlert(rule, orgId, trigger, data, logger) {
  const today = new Date().toISOString().slice(0, 10);
  // One alert per rule, entity, shift (when there is one) and day: without the rule a second
  // rule on the same trigger never fired; without the shift a missed afternoon round was
  // swallowed by that morning's alert. A re-run of a skipped tick still dedupes. [BUG-0045]
  const dedupKey = `${trigger}:${rule.id}:${data.entityId || 'scheduled'}${data.shift ? ':' + data.shift : ''}:${today}`;

  // Deduplicate — skip if the same rule+trigger+entity(+shift)+day already exists
  const existing = await prisma.alert.findUnique({
    where: { orgId_dedupKey: { orgId, dedupKey } }
  });
  if (existing) return;

  const severity = deriveSeverity(trigger, data);
  const title = data.title || buildAlertTitle(trigger, data);
  const body = data.body || buildAlertBody(trigger, data);

  const alert = await prisma.alert.create({
    data: {
      orgId,
      ruleId: rule.id,
      trigger,
      severity,
      title,
      body,
      entityType: data.entityType || null,
      entityId: data.entityId || null,
      // The escalation engine re-runs location-scoped actions (assigned supervisors and
      // electricians, CREATE_TICKET) from the stored alert alone, reading
      // metadata.locationId / metadata.module. The event payloads carry those at the top
      // level, so keep them here — without them every such escalation reached no one. [BUG-0019]
      metadata: data.metadata || (data.locationId ? { locationId: data.locationId, module: data.module || null } : null),
      actionsRun: rule.actions,
      dedupKey
    }
  });

  // Execute each configured action
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  for (const action of actions) {
    try {
      await executeAction(action, alert, orgId, data, logger);
    } catch (err) {
      if (logger) logger.error({ err, action, alertId: alert.id }, 'Alert action failed');
    }
  }

  // Push real-time SSE notification
  try { pushAlert(orgId, alert); } catch { /* silent */ }

  return alert;
}

function buildAlertTitle(trigger, data) {
  switch (trigger) {
    case 'INSPECTION_FAULT':
      return `Inspection faults: ${data.faultyCount} issues at ${data.locationName || 'a location'}`;
    case 'INSPECTION_LATE':
      return `Late inspection at ${data.locationName || 'a location'}`;
    case 'INSPECTION_MISSED':
      return `Missed inspection: ${data.locationName || 'location'} (${data.shift || 'shift'})`;
    case 'ASSET_FAILURE_REPORTED':
      return `Asset failure: ${data.assetCode || ''} — ${data.failureTitle || 'reported'}`;
    case 'ASSET_FAILURE_UNRESOLVED':
      return `Unresolved failure: ${data.failureTitle || ''} (${data.hoursOpen || '?'}h open)`;
    case 'ASSET_MAINTENANCE_OVERDUE':
      return `Maintenance overdue: ${data.assetCode || ''} — ${data.assetName || ''}`;
    case 'TICKET_HIGH_PRIORITY':
      return `${data.priority} ticket: ${data.ticketTitle || ''}`;
    case 'ATTENDANCE_LOW':
      return `Low attendance: ${data.absentCount || 0} absent today`;
    default:
      return 'Alert triggered';
  }
}

function buildAlertBody(trigger, data) {
  switch (trigger) {
    case 'INSPECTION_FAULT':
      return `${data.faultyCount} faulty item(s) found during ${data.shift || ''} shift inspection at ${data.locationName || 'location'}. Supervisor: ${data.supervisorName || 'N/A'}.`;
    case 'INSPECTION_LATE':
      return `Inspection submitted late for ${data.shift || ''} shift at ${data.locationName || 'location'}. Reason: ${data.lateReason || 'Not provided'}.`;
    case 'INSPECTION_MISSED':
      return `No inspection submitted for ${data.locationName || 'location'} during ${data.shift || ''} shift today.`;
    case 'ASSET_FAILURE_REPORTED':
      return `${data.severity || 'MEDIUM'} severity failure reported on ${data.assetCode || 'asset'}: ${data.failureTitle || ''}. ${data.description || ''}`.trim();
    case 'ASSET_FAILURE_UNRESOLVED':
      return `Failure "${data.failureTitle || ''}" on ${data.assetCode || 'asset'} has been open for ${data.hoursOpen || '?'} hours.`;
    case 'ASSET_MAINTENANCE_OVERDUE':
      return `${data.assetCode || 'Asset'} (${data.assetName || ''}) maintenance was due on ${data.dueDate || 'unknown date'}.`;
    case 'TICKET_HIGH_PRIORITY':
      return `${data.priority} priority ticket "${data.ticketTitle || ''}" created at ${data.locationName || 'location'}.`;
    case 'ATTENDANCE_LOW':
      return `${data.absentCount || 0} worker(s) marked absent today out of ${data.totalWorkers || '?'} total.`;
    default:
      return '';
  }
}

async function executeAction(action, alert, orgId, data, logger) {
  const type = action.type || action;

  switch (type) {
    case 'NOTIFY_ADMINS':
      await notifyAdmins(orgId, {
        type: 'alert_' + alert.trigger.toLowerCase(),
        title: alert.title,
        body: alert.body,
        entityId: alert.id
      });
      break;

    case 'NOTIFY_SUPERVISORS':
      await notifySupervisors(orgId, {
        type: 'alert_' + alert.trigger.toLowerCase(),
        title: alert.title,
        body: alert.body,
        entityId: alert.id
      });
      break;

    case 'NOTIFY_ASSIGNED_WORKERS': {
      // Resolve workers assigned to the alert's location (walks up hierarchy)
      const locId = data.locationId;
      if (!locId) break;
      const workerIds = await getAssignedWorkerIds(locId, orgId);
      if (workerIds.length) {
        const breadcrumb = await getLocationBreadcrumb(locId);
        await notifyWorkers(orgId, workerIds, {
          type: 'alert_' + alert.trigger.toLowerCase(),
          title: alert.title,
          body: (alert.body || '') + (breadcrumb ? ` [${breadcrumb}]` : ''),
          entityId: alert.id
        });
      }
      break;
    }

    case 'NOTIFY_ASSIGNED_SUPERVISORS': {
      // Resolve supervisors assigned to the alert's location (walks up hierarchy)
      const supLocId = data.locationId;
      if (!supLocId) break;
      const supervisorIds = await getAssignedSupervisorIds(supLocId, orgId);
      if (supervisorIds.length) {
        const breadcrumb = await getLocationBreadcrumb(supLocId);
        // Batched (single createMany) instead of one insert per supervisor,
        // matching the NOTIFY_ASSIGNED_WORKERS case just above. [WP11]
        await notifySupervisorIds(orgId, supervisorIds, {
          type: 'alert_' + alert.trigger.toLowerCase(),
          title: alert.title,
          body: (alert.body || '') + (breadcrumb ? ` [${breadcrumb}]` : ''),
          entityId: alert.id
        });
      }
      break;
    }

    case 'CREATE_TICKET': {
      // Auto-create a ticket from the alert, as a staff-raised ticket would be: assigned to the
      // supervisor covering the location, with an SLA deadline, audited, the assignee told.
      // It does not raise TICKET_HIGH_PRIORITY itself, so a rule cannot loop on its own
      // ticket. [BUG-0044]
      const locationId = data.locationId || null;
      if (!locationId) break; // Can't create ticket without a location
      const priority = TICKET_PRIORITIES.includes(action.priority) ? action.priority : 'HIGH';
      const [assignedToId = null] = await getAssignedSupervisorIds(locationId, orgId);
      const ticket = await prisma.ticket.create({
        data: {
          orgId,
          locationId,
          assignedToId,
          title: '[Auto] ' + alert.title,
          description: alert.body || null,
          priority,
          module: data.module || 'ele',
          source: 'INTERNAL',
          slaDeadlineAt: getSlaDeadline(priority)
        }
      });
      await prisma.auditLog.create({
        data: {
          orgId,
          actorType: 'system',
          action: 'ticket_created_by_alert',
          entityType: 'Ticket',
          entityId: ticket.id,
          newValue: { alertId: alert.id, ruleId: alert.ruleId || null, priority, assignedToId }
        }
      });
      if (assignedToId) {
        await createNotification({
          orgId,
          userId: assignedToId,
          type: 'ticket_assigned',
          title: 'New ticket assigned to you',
          body: ticket.title,
          entityId: ticket.id
        });
      }
      break;
    }

    default:
      if (logger) logger.warn({ type }, 'Unknown alert action type');
  }
}

// ─────────────────────────────────────────────
// SCHEDULED CHECKS
// Run periodically to detect time-based conditions
// ─────────────────────────────────────────────

// With { orgId }, one org only — what an admin's manual "run checks" may touch. [BUG-0032]
async function runScheduledChecks(logger, { orgId } = {}) {
  const orgs = await prisma.organization.findMany({
    where: { status: 'ACTIVE', ...(orgId ? { id: orgId } : {}) },
    select: { id: true, enabledModules: true }
  });

  for (const org of orgs) {
    try {
      const enabledMods = normalizeEnabledModules(org.enabledModules);

      // Always check inspection-based alerts
      if (isModuleEnabled(enabledMods, 'ele')) {
        await checkMissedInspections(org.id, logger);
      }

      // Asset module checks
      if (isModuleEnabled(enabledMods, 'asset')) {
        await checkUnresolvedFailures(org.id, logger);
        await checkOverdueMaintenance(org.id, logger);
      }

      await checkLowAttendance(org.id, logger);
    } catch (err) {
      logger.error({ err, orgId: org.id }, 'Scheduled alert check failed for org');
    }
  }
}

async function checkMissedInspections(orgId, logger) {
  const rules = await prisma.alertRule.findMany({
    where: { orgId, trigger: 'INSPECTION_MISSED', isActive: true }
  });
  if (!rules.length) return;

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const currentHour = now.getHours();

  // Get all active locations
  const locations = await prisma.location.findMany({
    where: { orgId, isActive: true },
    select: { id: true, name: true }
  });

  // Inspections since yesterday: a shift that crosses midnight began yesterday.
  const inspections = await prisma.electricalInspection.findMany({
    where: { orgId, inspectedAt: { gte: yesterdayStart, lte: now } },
    select: { locationId: true, shift: true, inspectedAt: true }
  });

  // Check each shift that has ended — deadlines follow this org's configured ShiftConfig
  // (falling back to the defaults) instead of a hardcoded table, so orgs with custom shift
  // windows get correctly-timed missed-inspection alerts. [WP10]
  // A day shift (MORNING, AFTERNOON) is checked from its end until midnight, against today's
  // inspections. A shift that crosses midnight (NIGHT, 22:00–06:00) ended this morning: it is
  // checked from its end until it starts again, against inspections since it began yesterday
  // evening. Before, NIGHT was checked during the night itself, against today only. [BUG-0045]
  const shiftConfigs = await getShiftConfigs(orgId);
  for (const shift of ['MORNING', 'AFTERNOON', 'NIGHT']) {
    const cfg = shiftConfigs[shift];
    const crossesMidnight = cfg.endHour <= cfg.startHour;
    let since;
    if (!crossesMidnight) {
      if (currentHour < cfg.endHour) continue;
      since = todayStart;
    } else {
      if (currentHour < cfg.endHour || currentHour >= cfg.startHour) continue;
      since = new Date(yesterdayStart); since.setHours(cfg.startHour, cfg.startMin || 0, 0, 0);
    }
    const inspected = new Set(inspections.filter((i) => i.shift === shift && i.inspectedAt >= since).map((i) => i.locationId));

    for (const loc of locations) {
      if (inspected.has(loc.id)) continue;

      const data = {
        entityType: 'location',
        entityId: loc.id,
        locationId: loc.id,
        locationName: loc.name,
        shift,
        module: 'ele'
      };

      for (const rule of rules) {
        const byHour = rule.conditions?.byHour;
        if (byHour && currentHour < byHour) continue;
        await fireAlert(rule, orgId, 'INSPECTION_MISSED', data, logger);
      }
    }
  }
}

async function checkUnresolvedFailures(orgId, logger) {
  const rules = await prisma.alertRule.findMany({
    where: { orgId, trigger: 'ASSET_FAILURE_UNRESOLVED', isActive: true }
  });
  if (!rules.length) return;

  const openFailures = await prisma.assetFailure.findMany({
    where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
    include: { asset: { select: { assetCode: true, name: true } } }
  });

  const now = Date.now();

  for (const failure of openFailures) {
    const hoursOpen = Math.floor((now - failure.failedAt.getTime()) / 3600000);

    const data = {
      entityType: 'failure',
      entityId: failure.id,
      assetCode: failure.asset.assetCode,
      assetName: failure.asset.name,
      failureTitle: failure.title,
      severity: failure.severity,
      hoursOpen
    };

    for (const rule of rules) {
      const threshold = rule.conditions?.hoursOpen || 24;
      if (hoursOpen < threshold) continue;
      await fireAlert(rule, orgId, 'ASSET_FAILURE_UNRESOLVED', data, logger);
    }
  }
}

async function checkOverdueMaintenance(orgId, logger) {
  const rules = await prisma.alertRule.findMany({
    where: { orgId, trigger: 'ASSET_MAINTENANCE_OVERDUE', isActive: true }
  });
  if (!rules.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdueAssets = await prisma.asset.findMany({
    where: {
      orgId,
      isActive: true,
      status: { not: 'DECOMMISSIONED' },
      nextMaintenanceDue: { lt: today }
    },
    select: { id: true, assetCode: true, name: true, nextMaintenanceDue: true }
  });

  for (const asset of overdueAssets) {
    const daysPast = Math.floor((today.getTime() - asset.nextMaintenanceDue.getTime()) / 86400000);

    const data = {
      entityType: 'asset',
      entityId: asset.id,
      assetCode: asset.assetCode,
      assetName: asset.name,
      dueDate: asset.nextMaintenanceDue.toISOString().slice(0, 10),
      daysPast
    };

    for (const rule of rules) {
      const minDays = rule.conditions?.daysPastDue || 1;
      if (daysPast < minDays) continue;
      await fireAlert(rule, orgId, 'ASSET_MAINTENANCE_OVERDUE', data, logger);
    }
  }
}

async function checkLowAttendance(orgId, logger) {
  const rules = await prisma.alertRule.findMany({
    where: { orgId, trigger: 'ATTENDANCE_LOW', isActive: true }
  });
  if (!rules.length) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalWorkers, absentCount] = await Promise.all([
    prisma.worker.count({ where: { orgId, isActive: true } }),
    prisma.attendance.count({
      where: { orgId, date: today, status: 'ABSENT' }
    })
  ]);

  if (absentCount === 0) return;

  const data = {
    entityType: 'attendance',
    entityId: 'attendance:' + today.toISOString().slice(0, 10),
    absentCount,
    totalWorkers
  };

  for (const rule of rules) {
    const minAbsent = rule.conditions?.minAbsent || 1;
    if (absentCount < minAbsent) continue;
    await fireAlert(rule, orgId, 'ATTENDANCE_LOW', data, logger);
  }
}

// ─────────────────────────────────────────────
// AI INSIGHTS (Scheduled daily)
// ─────────────────────────────────────────────

async function generateAiInsights(logger) {
  const orgs = await prisma.organization.findMany({
    where: { status: 'ACTIVE', aiEnabled: true },
    select: {
      id: true, name: true, type: true, enabledModules: true,
      aiProvider: true, aiModel: true, aiApiKey: true,
      aiMonthlyTokenLimit: true, aiTotalTokensUsed: true
    }
  });

  for (const org of orgs) {
    try {
      await generateDailyInsight(org, logger);
    } catch (err) {
      logger.error({ err, orgId: org.id }, 'AI insight generation failed');
    }
  }
}

async function generateDailyInsight(org, logger) {
  const today = new Date().toISOString().slice(0, 10);

  // Check if already generated today
  const existing = await prisma.aiInsight.findUnique({
    where: { orgId_type_period: { orgId: org.id, type: 'daily_summary', period: today } }
  });
  if (existing) return;

  // Resolve AI credentials
  const creds = resolveAiCredentials(org);
  if (!creds) return;

  // Check monthly token limit
  if (org.aiMonthlyTokenLimit && org.aiTotalTokensUsed >= org.aiMonthlyTokenLimit) {
    logger.info({ orgId: org.id }, 'AI token limit reached, skipping insight generation');
    return;
  }

  // Build data context
  const context = await buildInsightContext(org.id);

  const systemPrompt = `You are an operations analyst for a facility management platform. Generate a concise daily summary report.

FORMAT:
- Start with a one-line "Overall Status" assessment (Good / Needs Attention / Critical)
- Then 3-5 key findings as bullet points
- End with 1-2 actionable recommendations

RULES:
- Be specific — use numbers and names from the data
- Keep the entire response under 400 words
- Use markdown formatting (bold, bullets)
- Never make up data not in the context`;

  const userMessage = `Generate today's daily operations summary for ${today}.\n\nDATA:\n${context}`;

  const start = Date.now();
  const result = await callAiProvider(creds, systemPrompt, userMessage, 1024, 60000);
  const latencyMs = Date.now() - start;

  await prisma.aiInsight.create({
    data: {
      orgId: org.id,
      type: 'daily_summary',
      title: `Daily Summary — ${today}`,
      content: result.content,
      period: today,
      metadata: {
        provider: creds.provider,
        model: creds.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        latencyMs
      }
    }
  });

  // Increment token usage
  if (result.totalTokens) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { aiTotalTokensUsed: { increment: result.totalTokens } }
    }).catch(() => {});
  }

  logger.info({ orgId: org.id, tokens: result.totalTokens, latencyMs }, 'Daily AI insight generated');
}

// ── Build context for AI insights ──

async function buildInsightContext(orgId) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);

  const safe = (p, fb) => p.catch(() => fb);

  const [org, locations, workers, supervisors, todayInspections, weeklyStats,
    openTickets, todayAttendance, openFailures, overdueAssets, recentAlerts] = await Promise.all([
    safe(prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, type: true } }), null),
    safe(prisma.location.count({ where: { orgId, isActive: true } }), 0),
    safe(prisma.worker.count({ where: { orgId, isActive: true } }), 0),
    safe(prisma.user.count({ where: { orgId, role: 'SUPERVISOR', isActive: true } }), 0),
    safe(prisma.electricalInspection.findMany({
      where: { orgId, inspectedAt: { gte: todayStart, lte: todayEnd } },
      select: { shift: true, faultyCount: true, isLate: true, location: { select: { name: true } }, supervisor: { select: { name: true } } },
      take: 200
    }), []),
    safe(prisma.electricalInspection.groupBy({
      by: ['shift'], where: { orgId, inspectedAt: { gte: weekAgo } }, _count: true
    }), []),
    safe(prisma.ticket.findMany({
      where: { orgId, status: { in: ACTIVE_TICKET_STATUSES } },
      select: { title: true, priority: true, status: true, location: { select: { name: true } } },
      take: 15, orderBy: { createdAt: 'desc' }
    }), []),
    safe(prisma.attendance.groupBy({
      by: ['status'], where: { orgId, date: todayStart }, _count: true
    }), []),
    safe(prisma.assetFailure.findMany({
      where: { orgId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
      select: { title: true, severity: true, status: true, failedAt: true, asset: { select: { assetCode: true } } },
      take: 10, orderBy: { failedAt: 'desc' }
    }), []),
    safe(prisma.asset.count({
      where: { orgId, isActive: true, status: { not: 'DECOMMISSIONED' }, nextMaintenanceDue: { lt: todayStart } }
    }), 0),
    safe(prisma.alert.findMany({
      where: { orgId, createdAt: { gte: todayStart } },
      select: { trigger: true, severity: true, title: true },
      take: 10, orderBy: { createdAt: 'desc' }
    }), [])
  ]);

  const inspectedCount = todayInspections.length;
  const faultInspections = todayInspections.filter(i => i.faultyCount > 0);
  const lateInspections = todayInspections.filter(i => i.isLate);
  const totalFaults = todayInspections.reduce((s, i) => s + i.faultyCount, 0);

  const shiftBreakdown = {};
  todayInspections.forEach(i => { shiftBreakdown[i.shift] = (shiftBreakdown[i.shift] || 0) + 1; });

  const attendanceMap = {};
  todayAttendance.forEach(a => {
    attendanceMap[a.status] = typeof a._count === 'number' ? a._count : a._count?._all || 0;
  });

  let ctx = `ORGANIZATION: ${org?.name || 'Unknown'} (${org?.type || 'General'})
DATE: ${now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

INSPECTIONS TODAY:
- Total: ${inspectedCount} / ${locations} locations
- Pending: ${Math.max(locations - inspectedCount, 0)}
- With faults: ${faultInspections.length} (${totalFaults} total fault items)
- Late submissions: ${lateInspections.length}
- By shift: ${Object.entries(shiftBreakdown).map(([s, c]) => s + ':' + c).join(', ') || 'None'}

TEAM: ${workers} workers, ${supervisors} supervisors
ATTENDANCE TODAY: Present=${attendanceMap.PRESENT || 0}, Absent=${attendanceMap.ABSENT || 0}, Leave=${attendanceMap.LEAVE || 0}

OPEN TICKETS (${openTickets.length}):
${openTickets.map(t => '- ' + t.priority + ': ' + t.title + ' @ ' + (t.location?.name || '?')).join('\n') || '- None'}

OPEN ASSET FAILURES (${openFailures.length}):
${openFailures.map(f => '- ' + f.severity + ': ' + f.title + ' (' + f.asset.assetCode + ') — ' + f.status).join('\n') || '- None'}

OVERDUE MAINTENANCE: ${overdueAssets} asset(s)

TODAY'S ALERTS (${recentAlerts.length}):
${recentAlerts.map(a => '- [' + a.severity + '] ' + a.title).join('\n') || '- None'}`;

  if (ctx.length > 50000) ctx = ctx.slice(0, 50000) + '\n[Truncated]';
  return ctx;
}

// ── AI Provider Calling ──
// Consolidated into lib/ai-provider.js — resolveAiCredentials/callAiProvider
// are re-exported below (see module.exports) for predictions.js, which
// consumes them from this module rather than requiring the shared module
// directly, for backward compatibility. callAiProvider now carries circuit
// breaker protection internally, closing the gap where generateDailyInsight
// (below) previously called the provider with no breaker at all. [WP10]

// ─────────────────────────────────────────────
// ESCALATION ENGINE
// Checks unacknowledged alerts past their escalation window
// ─────────────────────────────────────────────

// With { orgId }, one org only — what an admin's manual "run escalations" may touch.
// Suspended and deleted orgs never escalate. [BUG-0032]
async function runEscalationChecks(logger, { orgId } = {}) {
  try {
    // Find all active rules that have escalation configured
    const rules = await prisma.alertRule.findMany({
      where: {
        isActive: true,
        escalateAfterMinutes: { not: null },
        org: { status: 'ACTIVE' },
        ...(orgId ? { orgId } : {})
      },
      select: {
        id: true, orgId: true, escalateAfterMinutes: true,
        escalationActions: true, maxEscalations: true, trigger: true, name: true
      }
    });

    if (!rules.length) return;

    const rulesByOrg = {};
    for (const r of rules) {
      if (!rulesByOrg[r.orgId]) rulesByOrg[r.orgId] = [];
      rulesByOrg[r.orgId].push(r);
    }

    for (const [orgId, orgRules] of Object.entries(rulesByOrg)) {
      const ruleIds = orgRules.map(r => r.id);

      // Find unacknowledged alerts linked to rules with escalation
      const unacked = await prisma.alert.findMany({
        where: {
          orgId,
          ruleId: { in: ruleIds },
          acknowledged: false
        }
      });

      for (const alert of unacked) {
        const rule = orgRules.find(r => r.id === alert.ruleId);
        if (!rule || !rule.escalateAfterMinutes) continue;

        const maxEsc = rule.maxEscalations || 1;
        if (alert.escalationLevel >= maxEsc) continue;

        // Check if enough time has passed since alert creation or last escalation
        const refTime = alert.lastEscalatedAt || alert.createdAt;
        const minutesSince = (Date.now() - refTime.getTime()) / 60000;
        if (minutesSince < rule.escalateAfterMinutes) continue;

        // Escalate!
        const newLevel = alert.escalationLevel + 1;
        await prisma.alert.update({
          where: { id: alert.id },
          data: {
            escalationLevel: newLevel,
            lastEscalatedAt: new Date()
          }
        });

        // Execute escalation actions
        const escActions = Array.isArray(rule.escalationActions) ? rule.escalationActions : [];
        for (const action of escActions) {
          try {
            await executeAction(action, { ...alert, escalationLevel: newLevel }, orgId, {
              entityType: alert.entityType,
              entityId: alert.entityId,
              locationId: alert.metadata?.locationId || null,
              module: alert.metadata?.module || 'ele'
            }, logger);
          } catch (err) {
            if (logger) logger.error({ err, action, alertId: alert.id }, 'Escalation action failed');
          }
        }

        // Notify about escalation
        await notifyAdmins(orgId, {
          type: 'escalation',
          title: `⚠ Escalation (Level ${newLevel}): ${alert.title}`,
          body: `Alert "${alert.title}" was not acknowledged within ${rule.escalateAfterMinutes} minutes. Escalated to level ${newLevel}.`,
          entityId: alert.id
        });

        // Push via SSE
        try { pushAlert(orgId, { ...alert, escalationLevel: newLevel }); } catch { /* silent */ }

        if (logger) logger.info({ alertId: alert.id, level: newLevel, orgId }, 'Alert escalated');
      }
    }
  } catch (err) {
    if (logger) logger.error({ err }, 'Escalation check failed');
  }
}

// ─────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────

let _lastInsightHour = -1;

// Wraps each job with an advisory-lock gate (src/lib/scheduler-lock.js) — see
// services/cleanup.js's runJob for the same pattern and its rationale. A skipped
// tick here is caught by the next one; nothing is lost, since evaluateEvent's own
// per-day dedupKey already tolerates being (re-)checked more than once.
function runJob(lockKey, jobFn, logger, errMsg) {
  return runExclusive(prisma, lockKey, jobFn, logger).catch(err => logger.error({ err }, errMsg));
}

function startAutomationScheduler(logger) {
  logger.info('Automation scheduler starting...');

  // Run scheduled checks 60 seconds after boot, then every 30 minutes
  const startupTimeout = setTimeout(() => {
    runJob(LOCK_KEYS.SCHEDULED_CHECKS, () => runScheduledChecks(logger), logger, 'Initial scheduled check failed');
    runJob(LOCK_KEYS.ESCALATION_CHECKS, () => runEscalationChecks(logger), logger, 'Initial escalation check failed');
  }, 60000);

  // Escalation checks every 5 minutes (time-sensitive)
  const escalationInterval = setInterval(() => {
    runJob(LOCK_KEYS.ESCALATION_CHECKS, () => runEscalationChecks(logger), logger, 'Escalation check failed');
  }, 5 * 60 * 1000);

  const checkInterval = setInterval(() => {
    runJob(LOCK_KEYS.SCHEDULED_CHECKS, () => runScheduledChecks(logger), logger, 'Scheduled check failed');

    // Generate AI insights once per day (around 6 AM or first run after)
    const hour = new Date().getHours();
    if ((hour >= 6 && hour <= 8) && _lastInsightHour !== hour) {
      _lastInsightHour = hour;
      runJob(LOCK_KEYS.AI_DAILY_INSIGHTS, () => generateAiInsights(logger), logger, 'AI insight generation failed');
    }
  }, 30 * 60 * 1000); // 30 minutes

  // Returned so index.js can clear every timer on graceful shutdown.
  return { startupTimeout, escalationInterval, checkInterval };
}

// ─────────────────────────────────────────────
// CLEANUP: Old alerts + insights
// ─────────────────────────────────────────────

async function cleanupOldAlerts(logger) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90); // 90-day retention

  const [alertResult, insightResult] = await Promise.all([
    prisma.alert.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.aiInsight.deleteMany({ where: { createdAt: { lt: cutoff } } })
  ]);

  if (alertResult.count || insightResult.count) {
    logger.info({ alerts: alertResult.count, insights: insightResult.count }, 'Cleaned up old alerts/insights');
  }
}

module.exports = {
  evaluateEvent,
  runScheduledChecks,
  runEscalationChecks,
  generateAiInsights,
  cleanupOldAlerts,
  startAutomationScheduler,
  // Exposed for predictions service
  resolveAiCredentials,
  callAiProvider
};
