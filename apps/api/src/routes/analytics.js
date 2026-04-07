'use strict';

const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

async function analyticsRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN'));

  // Dashboard overview — electrical-focused
  fastify.get('/analytics/dashboard', async (request) => {
    const orgId = request.user.orgId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekAgo = new Date(todayStart);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      totalLocations,
      activeWorkers,
      activeSupervisors,
      todayInspections,
      yesterdayInspections,
      weekInspections,
      openTickets,
      totalInspections,
      todayFaults,
      openFaults,
      todayInspectionShifts,
      shiftConfigRows
    ] = await Promise.all([
      prisma.location.count({ where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } } }),
      prisma.worker.count({ where: { orgId, isActive: true } }),
      prisma.user.count({ where: { orgId, role: 'SUPERVISOR', isActive: true } }),
      prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: todayStart } } }),
      prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: weekAgo } } }),
      prisma.ticket.count({ where: { orgId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.electricalInspection.count({ where: { orgId } }),
      prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: todayStart }, faultyCount: { gt: 0 } } }),
      prisma.electricalInspection.count({ where: { orgId, faultyCount: { gt: 0 }, status: 'SUBMITTED' } }),
      // Today's inspections for shift progress
      prisma.electricalInspection.findMany({
        where: { orgId, inspectedAt: { gte: todayStart, lte: todayEnd } },
        select: { locationId: true, shift: true }
      }),
      prisma.shiftConfig.findMany({ where: { orgId } })
    ]);

    const weeklyAvg = weekInspections > 0 ? Math.round(weekInspections / 7 * 10) / 10 : 0;

    // Calculate shift-wise progress from today's inspections
    const shiftDone = { MORNING: 0, AFTERNOON: 0, NIGHT: 0, GENERAL: 0 };
    const locationsByShift = { MORNING: new Set(), AFTERNOON: new Set(), NIGHT: new Set(), GENERAL: new Set() };
    for (const rec of todayInspectionShifts) {
      if (!locationsByShift[rec.shift]?.has(rec.locationId)) {
        shiftDone[rec.shift] = (shiftDone[rec.shift] || 0) + 1;
        if (locationsByShift[rec.shift]) locationsByShift[rec.shift].add(rec.locationId);
      }
    }

    // Build shift config with defaults
    const defaultShifts = {
      MORNING:   { startHour: 6, startMin: 0, endHour: 14, endMin: 0 },
      AFTERNOON: { startHour: 14, startMin: 0, endHour: 22, endMin: 0 },
      NIGHT:     { startHour: 22, startMin: 0, endHour: 6, endMin: 0 },
      GENERAL:   { startHour: 0, startMin: 0, endHour: 0, endMin: 0 }
    };
    for (const r of shiftConfigRows) {
      defaultShifts[r.shift] = { startHour: r.startHour, startMin: r.startMin, endHour: r.endHour, endMin: r.endMin };
    }

    return {
      totalLocations,
      activeWorkers,
      activeSupervisors,
      todayInspections,
      yesterdayInspections,
      weeklyAvg,
      openTickets,
      totalInspections,
      todayFaults,
      openFaults,
      shiftProgress: {
        MORNING: { done: shiftDone.MORNING },
        AFTERNOON: { done: shiftDone.AFTERNOON },
        NIGHT: { done: shiftDone.NIGHT },
        GENERAL: { done: shiftDone.GENERAL }
      },
      shiftConfig: defaultShifts
    };
  });

  // Inspection activity trend (daily counts for last N days)
  fastify.get('/analytics/inspection-trend', async (request) => {
    const orgId = request.user.orgId;
    const days = Math.min(parseInt(request.query.days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const trend = await prisma.$queryRaw`
      SELECT DATE("inspectedAt") as date, COUNT(*)::int as count
       FROM "ElectricalInspection"
       WHERE "orgId"::text = ${orgId} AND "inspectedAt" >= ${since}
       GROUP BY DATE("inspectedAt")
       ORDER BY date ASC`;

    const allDays = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      allDays.push(d.toISOString().split('T')[0]);
    }
    const countMap = new Map((trend || []).map(d => {
      const dateStr = typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0];
      return [dateStr, d.count];
    }));
    return { trend: allDays.map(date => ({ date, count: countMap.get(date) || 0 })) };
  });

  // Fault trend — daily fault counts
  fastify.get('/analytics/fault-trend', async (request) => {
    const orgId = request.user.orgId;
    const days = Math.min(parseInt(request.query.days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const trend = await prisma.$queryRaw`
      SELECT DATE("inspectedAt") as date, COUNT(*)::int as count
       FROM "ElectricalInspection"
       WHERE "orgId"::text = ${orgId} AND "inspectedAt" >= ${since} AND "faultyCount" > 0
       GROUP BY DATE("inspectedAt")
       ORDER BY date ASC`;

    const allDays = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      allDays.push(d.toISOString().split('T')[0]);
    }
    const countMap = new Map((trend || []).map(d => {
      const dateStr = typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0];
      return [dateStr, d.count];
    }));
    return { trend: allDays.map(date => ({ date, count: countMap.get(date) || 0 })) };
  });

  // Worker performance — ranked by inspections, flagged, faults
  fastify.get('/analytics/workers', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    const workers = await prisma.worker.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true, name: true, phone: true,
        electricalInspections: {
          where: hasDateFilter ? { inspectedAt: dateFilter } : undefined,
          select: {
            id: true,
            status: true,
            locationId: true,
            faultyCount: true,
            supervisor: { select: { id: true, name: true } }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    // Collect location IDs for ticket correlation
    const allLocationIds = new Set();
    for (const w of workers) {
      for (const r of w.electricalInspections) allLocationIds.add(r.locationId);
    }

    let ticketsByLocation = new Map();
    if (allLocationIds.size > 0) {
      const ticketGroups = await prisma.ticket.groupBy({
        by: ['locationId'],
        where: {
          orgId,
          locationId: { in: [...allLocationIds] },
          ...(hasDateFilter ? { createdAt: dateFilter } : {})
        },
        _count: true
      });
      for (const g of ticketGroups) ticketsByLocation.set(g.locationId, g._count);
    }

    const result = workers.map(w => {
      const records = w.electricalInspections;
      const inspectionCount = records.length;
      const flaggedCount = records.filter(r => r.status === 'FLAGGED').length;
      const totalFaults = records.reduce((s, r) => s + r.faultyCount, 0);

      const workerLocationIds = new Set(records.map(r => r.locationId));
      let locationTicketCount = 0;
      for (const locId of workerLocationIds) {
        locationTicketCount += ticketsByLocation.get(locId) || 0;
      }

      const supMap = new Map();
      for (const r of records) {
        if (r.supervisor && !supMap.has(r.supervisor.id)) {
          supMap.set(r.supervisor.id, r.supervisor.name);
        }
      }
      const supervisors = [...supMap.entries()].map(([id, name]) => ({ id, name }));

      const score = inspectionCount - (flaggedCount * 3) - (locationTicketCount * 1);

      return {
        id: w.id,
        name: w.name,
        phone: w.phone,
        inspectionCount,
        flaggedCount,
        totalFaults,
        locationTicketCount,
        supervisors,
        score
      };
    });

    result.sort((a, b) => b.score - a.score);
    return result;
  });

  // Location inspection history
  fastify.get('/analytics/locations', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const locations = await prisma.location.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true, name: true, type: true,
        electricalInspections: {
          where: Object.keys(dateFilter).length ? { inspectedAt: dateFilter } : undefined,
          select: { id: true, faultyCount: true }
        }
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }]
    });

    return locations.map(l => ({
      id: l.id,
      name: l.name,
      type: l.type,
      inspectionCount: l.electricalInspections.length,
      totalFaults: l.electricalInspections.reduce((s, r) => s + r.faultyCount, 0)
    }));
  });

  // Supervisor activity
  fastify.get('/analytics/supervisors', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const supervisors = await prisma.user.findMany({
      where: { orgId, role: 'SUPERVISOR', isActive: true },
      select: {
        id: true, name: true, email: true,
        electricalInspections: {
          where: Object.keys(dateFilter).length ? { inspectedAt: dateFilter } : undefined,
          select: { id: true, faultyCount: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    return supervisors.map(s => ({
      id: s.id,
      name: s.name,
      email: s.email,
      inspectionCount: s.electricalInspections.length,
      totalFaults: s.electricalInspections.reduce((sum, r) => sum + r.faultyCount, 0)
    })).sort((a, b) => b.inspectionCount - a.inspectionCount);
  });

  // Problem locations — combines faults, flagged inspections, and tickets
  fastify.get('/analytics/problem-locations', async (request) => {
    const orgId = request.user.orgId;
    const { days } = request.query;

    const lookbackDays = Math.min(parseInt(days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    since.setHours(0, 0, 0, 0);

    const [faultInspections, openTickets] = await Promise.all([
      prisma.electricalInspection.findMany({
        where: { orgId, inspectedAt: { gte: since }, faultyCount: { gt: 0 } },
        select: { locationId: true, faultyCount: true, status: true }
      }),
      prisma.ticket.findMany({
        where: { orgId, status: { in: ['OPEN', 'IN_PROGRESS'] }, createdAt: { gte: since } },
        select: { locationId: true, priority: true }
      })
    ]);

    const scoreMap = new Map();
    function getEntry(locationId) {
      if (!scoreMap.has(locationId)) {
        scoreMap.set(locationId, { faultCount: 0, flaggedCount: 0, ticketCount: 0, urgentTickets: 0, score: 0 });
      }
      return scoreMap.get(locationId);
    }

    for (const insp of faultInspections) {
      const entry = getEntry(insp.locationId);
      entry.faultCount += insp.faultyCount;
      if (insp.status === 'FLAGGED') entry.flaggedCount++;
    }

    for (const ticket of openTickets) {
      const entry = getEntry(ticket.locationId);
      entry.ticketCount++;
      if (ticket.priority === 'HIGH' || ticket.priority === 'URGENT') entry.urgentTickets++;
    }

    for (const entry of scoreMap.values()) {
      entry.score = (entry.faultCount * 5) + (entry.flaggedCount * 3) + (entry.urgentTickets * 4) + (entry.ticketCount * 2);
    }

    const problemIds = [...scoreMap.entries()].filter(([, e]) => e.score > 0).map(([id]) => id);
    if (problemIds.length === 0) return { locations: [], lookbackDays };

    const locations = await prisma.location.findMany({
      where: { id: { in: problemIds } },
      select: {
        id: true, name: true, type: true, qrCode: true,
        parent: { select: { id: true, name: true, type: true } }
      }
    });

    const locMap = new Map(locations.map(l => [l.id, l]));

    const ranked = problemIds.map(id => ({
      location: locMap.get(id),
      ...scoreMap.get(id)
    })).sort((a, b) => b.score - a.score);

    return { locations: ranked, lookbackDays };
  });

  // Inspection status board — visual overview of all locations' inspection status today
  fastify.get('/analytics/inspection-status', async (request, reply) => {
    const orgId = request.user.orgId;
    const { date } = request.query;

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (date && !dateRe.test(date)) return reply.code(400).send({ error: 'Invalid date format. Use YYYY-MM-DD.' });

    const targetDate = date ? new Date(date + 'T00:00:00') : new Date();
    if (isNaN(targetDate.getTime())) return reply.code(400).send({ error: 'Invalid date value.' });
    const dayStart = new Date(targetDate); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate); dayEnd.setHours(23, 59, 59, 999);

    const locations = await prisma.location.findMany({
      where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } },
      select: {
        id: true, name: true, type: true,
        parent: { select: { name: true } },
        electricalInspections: {
          where: { inspectedAt: { gte: dayStart, lte: dayEnd } },
          select: { shift: true, inspectedAt: true, faultyCount: true, supervisor: { select: { name: true } } },
          orderBy: { inspectedAt: 'desc' }
        }
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }]
    });

    return locations.map(loc => {
      const inspections = loc.electricalInspections;
      const hasFaults = inspections.some(i => i.faultyCount > 0);
      const totalFaults = inspections.reduce((s, i) => s + i.faultyCount, 0);

      let status;
      if (inspections.length === 0) status = 'NOT_INSPECTED';
      else if (hasFaults) status = 'HAS_FAULTS';
      else status = 'INSPECTED';

      return {
        id: loc.id,
        name: loc.name,
        type: loc.type,
        parentName: loc.parent?.name || null,
        status,
        inspectionCount: inspections.length,
        totalFaults,
        completedShifts: inspections.map(i => i.shift),
        lastInspectedAt: inspections[0]?.inspectedAt || null,
        lastSupervisor: inspections[0]?.supervisor?.name || null
      };
    });
  });

  // Comprehensive report for analytics page (period-based)
  fastify.get('/analytics/report', async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (from && !dateRe.test(from)) return reply.code(400).send({ error: 'Invalid from date format. Use YYYY-MM-DD.' });
    if (to && !dateRe.test(to)) return reply.code(400).send({ error: 'Invalid to date format. Use YYYY-MM-DD.' });
    const periodStart = from ? new Date(from + 'T00:00:00') : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
    const periodEnd = to ? new Date(to + 'T23:59:59.999') : (() => { const d = new Date(); d.setHours(23,59,59,999); return d; })();
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) return reply.code(400).send({ error: 'Invalid date value.' });
    if (periodStart > periodEnd) return reply.code(400).send({ error: 'from date must be before or equal to to date.' });

    const periodMs = periodEnd - periodStart;
    const daysInPeriod = Math.max(1, Math.round(periodMs / (1000 * 60 * 60 * 24)));

    const prevDuration = Math.max(periodMs, 86400000);
    const prevEnd = new Date(periodStart.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - prevDuration + 1);
    prevStart.setHours(0, 0, 0, 0);

    const [
      inspections,
      prevInspectionCount,
      prevFlaggedCount,
      tickets,
      prevTicketCount,
      locations,
      workers,
      supervisors
    ] = await Promise.all([
      prisma.electricalInspection.findMany({
        where: { orgId, inspectedAt: { gte: periodStart, lte: periodEnd } },
        select: {
          id: true, shift: true, status: true, inspectedAt: true, faultyCount: true,
          locationId: true,
          location: { select: { id: true, name: true, type: true, parent: { select: { name: true } } } },
          supervisor: { select: { id: true, name: true } },
          workers: { select: { id: true, name: true } },
          images: { select: { id: true } },
          items: { select: { checkType: true, status: true } }
        }
      }),
      prisma.electricalInspection.count({
        where: { orgId, inspectedAt: { gte: prevStart, lte: prevEnd } }
      }),
      prisma.electricalInspection.count({
        where: { orgId, inspectedAt: { gte: prevStart, lte: prevEnd }, status: 'FLAGGED' }
      }),
      prisma.ticket.findMany({
        where: { orgId, createdAt: { gte: periodStart, lte: periodEnd } },
        select: {
          id: true, title: true, priority: true, status: true, source: true,
          issueType: true, createdAt: true, resolvedAt: true,
          locationId: true,
          location: { select: { id: true, name: true, type: true, parent: { select: { name: true } } } }
        }
      }),
      prisma.ticket.count({
        where: { orgId, createdAt: { gte: prevStart, lte: prevEnd } }
      }),
      prisma.location.findMany({
        where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } },
        select: {
          id: true, name: true, type: true,
          parent: { select: { name: true } }
        }
      }),
      prisma.worker.findMany({
        where: { orgId, isActive: true },
        select: { id: true, name: true, employeeId: true }
      }),
      prisma.user.findMany({
        where: { orgId, role: 'SUPERVISOR', isActive: true },
        select: { id: true, name: true }
      })
    ]);

    // Summary
    const totalInspections = inspections.length;
    const flaggedInspections = inspections.filter(r => r.status === 'FLAGGED').length;
    const totalFaults = inspections.reduce((s, r) => s + r.faultyCount, 0);
    const totalImages = inspections.reduce((s, r) => s + r.images.length, 0);
    const changePercent = prevInspectionCount > 0 ? Math.round((totalInspections - prevInspectionCount) / prevInspectionCount * 100) : (totalInspections > 0 ? 100 : 0);
    const flaggedRate = totalInspections > 0 ? Math.round(flaggedInspections / totalInspections * 1000) / 10 : 0;
    const avgPerDay = daysInPeriod > 0 ? Math.round(totalInspections / daysInPeriod * 10) / 10 : 0;

    // By Shift
    const byShift = {};
    for (const r of inspections) {
      byShift[r.shift] = (byShift[r.shift] || 0) + 1;
    }

    // By check type — aggregate item-level fault stats
    const byCheckType = {};
    for (const insp of inspections) {
      for (const item of insp.items) {
        if (!byCheckType[item.checkType]) byCheckType[item.checkType] = { total: 0, faulty: 0, ok: 0, na: 0 };
        const ct = byCheckType[item.checkType];
        ct.total++;
        if (item.status === 'FAULTY') ct.faulty++;
        else if (item.status === 'OK') ct.ok++;
        else ct.na++;
      }
    }

    // Daily trend
    const dayMap = new Map();
    const faultDayMap = new Map();
    for (const r of inspections) {
      const day = r.inspectedAt.toISOString().split('T')[0];
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
      if (r.faultyCount > 0) faultDayMap.set(day, (faultDayMap.get(day) || 0) + 1);
    }
    const trend = [];
    const faultTrend = [];
    const d = new Date(periodStart);
    while (d <= periodEnd) {
      const key = d.toISOString().split('T')[0];
      trend.push({ date: key, count: dayMap.get(key) || 0 });
      faultTrend.push({ date: key, count: faultDayMap.get(key) || 0 });
      d.setDate(d.getDate() + 1);
    }

    // Location breakdown
    const locInspMap = new Map();
    for (const r of inspections) {
      if (!locInspMap.has(r.locationId)) locInspMap.set(r.locationId, { count: 0, faults: 0 });
      const entry = locInspMap.get(r.locationId);
      entry.count++;
      entry.faults += r.faultyCount;
    }

    const ticketCountByLoc = new Map();
    for (const t of tickets) {
      ticketCountByLoc.set(t.locationId, (ticketCountByLoc.get(t.locationId) || 0) + 1);
    }

    const locationBreakdown = locations.map(loc => {
      const data = locInspMap.get(loc.id) || { count: 0, faults: 0 };
      return {
        id: loc.id,
        name: loc.name,
        type: loc.type,
        parentName: loc.parent?.name || null,
        inspections: data.count,
        faults: data.faults,
        tickets: ticketCountByLoc.get(loc.id) || 0
      };
    }).sort((a, b) => b.faults - a.faults);

    // Ticket stats
    const ticketsByPriority = {};
    const ticketsByStatus = {};
    const ticketsBySource = { INTERNAL: 0, PUBLIC: 0 };
    const ticketsByIssueType = {};
    const ticketsByLocation = new Map();
    let resolvedCount = 0, resolutionTotal = 0;

    for (const t of tickets) {
      ticketsByPriority[t.priority] = (ticketsByPriority[t.priority] || 0) + 1;
      ticketsByStatus[t.status] = (ticketsByStatus[t.status] || 0) + 1;
      ticketsBySource[t.source || 'INTERNAL'] = (ticketsBySource[t.source || 'INTERNAL'] || 0) + 1;
      if (t.issueType) ticketsByIssueType[t.issueType] = (ticketsByIssueType[t.issueType] || 0) + 1;

      if (!ticketsByLocation.has(t.locationId)) {
        ticketsByLocation.set(t.locationId, { name: (t.location.parent?.name ? t.location.parent.name + ' → ' : '') + t.location.name, count: 0 });
      }
      ticketsByLocation.get(t.locationId).count++;

      if (t.resolvedAt) {
        resolvedCount++;
        resolutionTotal += (new Date(t.resolvedAt) - new Date(t.createdAt));
      }
    }
    const avgResolutionMs = resolvedCount > 0 ? Math.round(resolutionTotal / resolvedCount) : 0;
    const ticketLocations = [...ticketsByLocation.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    // Worker performance
    const workerMap = new Map();
    for (const r of inspections) {
      for (const w of r.workers) {
        if (!workerMap.has(w.id)) workerMap.set(w.id, { id: w.id, name: w.name, inspections: 0, flagged: 0, faults: 0, images: 0 });
        const entry = workerMap.get(w.id);
        entry.inspections++;
        if (r.status === 'FLAGGED') entry.flagged++;
        entry.faults += r.faultyCount;
        entry.images += r.images.length;
      }
    }
    const topWorkers = [...workerMap.values()].map(w => ({
      ...w,
      flaggedRate: w.inspections > 0 ? Math.round(w.flagged / w.inspections * 1000) / 10 : 0,
      score: w.inspections - (w.flagged * 3)
    })).sort((a, b) => b.inspections - a.inspections).slice(0, 10);

    // Supervisor performance
    const supMap = new Map();
    for (const r of inspections) {
      if (r.supervisor) {
        if (!supMap.has(r.supervisor.id)) supMap.set(r.supervisor.id, { id: r.supervisor.id, name: r.supervisor.name, inspections: 0, flagged: 0, faults: 0 });
        const entry = supMap.get(r.supervisor.id);
        entry.inspections++;
        if (r.status === 'FLAGGED') entry.flagged++;
        entry.faults += r.faultyCount;
      }
    }
    const topSupervisors = [...supMap.values()].map(s => ({
      ...s,
      flaggedRate: s.inspections > 0 ? Math.round(s.flagged / s.inspections * 1000) / 10 : 0
    })).sort((a, b) => b.inspections - a.inspections).slice(0, 10);

    return {
      period: { from: periodStart.toISOString().split('T')[0], to: periodEnd.toISOString().split('T')[0], days: daysInPeriod },
      summary: {
        totalInspections,
        prevInspections: prevInspectionCount,
        changePercent,
        flaggedInspections,
        flaggedRate,
        totalFaults,
        totalImages,
        totalLocations: locations.length,
        avgPerDay,
        totalWorkers: workers.length,
        totalSupervisors: supervisors.length,
        totalTickets: tickets.length,
        prevTickets: prevTicketCount
      },
      byShift,
      byCheckType,
      trend,
      faultTrend,
      locationBreakdown,
      ticketStats: {
        total: tickets.length,
        byPriority: ticketsByPriority,
        byStatus: ticketsByStatus,
        bySource: ticketsBySource,
        byIssueType: ticketsByIssueType,
        topLocations: ticketLocations,
        resolved: resolvedCount,
        avgResolutionHours: avgResolutionMs > 0 ? Math.round(avgResolutionMs / (1000 * 60 * 60) * 10) / 10 : null
      },
      topWorkers,
      topSupervisors
    };
  });

  // Location heatmap — inspection status per location per day
  fastify.get('/analytics/room-heatmap', async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (from && !dateRe.test(from)) return reply.code(400).send({ error: 'Invalid from date format. Use YYYY-MM-DD.' });
    if (to && !dateRe.test(to)) return reply.code(400).send({ error: 'Invalid to date format. Use YYYY-MM-DD.' });

    const periodStart = from ? new Date(from + 'T00:00:00') : (() => { const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0,0,0,0); return d; })();
    const periodEnd = to ? new Date(to + 'T23:59:59.999') : (() => { const d = new Date(); d.setHours(23,59,59,999); return d; })();
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) return reply.code(400).send({ error: 'Invalid date value.' });

    // Cap at 90 days
    const maxMs = 90 * 24 * 60 * 60 * 1000;
    if (periodEnd - periodStart > maxMs) return reply.code(400).send({ error: 'Date range cannot exceed 90 days.' });

    // Build dates array
    const dates = [];
    const d = new Date(periodStart);
    while (d <= periodEnd) {
      dates.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
    if (dates.length === 0) return { dates: [], locations: [] };

    const todayStr = new Date().toISOString().split('T')[0];

    // Fetch all leaf locations
    const locations = await prisma.location.findMany({
      where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } },
      select: {
        id: true, name: true, type: true,
        parent: { select: { name: true } }
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }]
    });

    if (locations.length === 0) return { dates, locations: [] };

    // Fetch all inspections in the range, grouped by location + date
    const inspections = await prisma.electricalInspection.findMany({
      where: { orgId, inspectedAt: { gte: periodStart, lte: periodEnd } },
      select: { locationId: true, inspectedAt: true, faultyCount: true }
    });

    // Build lookup: locationId → dateStr → { count, faults }
    const inspMap = new Map();
    for (const insp of inspections) {
      const dateStr = insp.inspectedAt.toISOString().split('T')[0];
      const key = insp.locationId + '|' + dateStr;
      if (!inspMap.has(key)) inspMap.set(key, { count: 0, faults: 0 });
      const entry = inspMap.get(key);
      entry.count++;
      entry.faults += insp.faultyCount;
    }

    // Build response
    const result = locations.map(loc => {
      let inspectedDays = 0;
      let pastDays = 0;

      const days = dates.map(dateStr => {
        const key = loc.id + '|' + dateStr;
        const data = inspMap.get(key);

        if (dateStr > todayStr) {
          return { status: 'UPCOMING', done: 0, required: 1 };
        }

        pastDays++;
        if (data && data.count > 0) {
          inspectedDays++;
          if (data.faults > 0) {
            return { status: 'PARTIAL', done: data.count, required: 1 };
          }
          return { status: 'CLEANED', done: data.count, required: 1 };
        }
        return { status: 'NOT_CLEANED', done: 0, required: 1 };
      });

      const score = pastDays > 0 ? Math.round(inspectedDays / pastDays * 100) : 0;

      return {
        id: loc.id,
        name: loc.name,
        parentName: loc.parent?.name || null,
        score,
        days
      };
    });

    return { dates, locations: result };
  });

  // Location inspection history — single location drill-down
  fastify.get('/analytics/location/:id/history', async (request, reply) => {
    const orgId = request.user.orgId;
    const { id } = request.params;
    const days = Math.min(parseInt(request.query.days) || 7, 90);

    const location = await prisma.location.findFirst({
      where: { id, orgId },
      select: {
        id: true, name: true, type: true,
        parent: { select: { name: true } }
      }
    });
    if (!location) return reply.code(404).send({ error: 'Location not found.' });

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const inspections = await prisma.electricalInspection.findMany({
      where: { locationId: id, orgId, inspectedAt: { gte: since } },
      select: {
        id: true, shift: true, inspectedAt: true, status: true, notes: true, faultyCount: true,
        supervisor: { select: { name: true } },
        workers: { select: { name: true } },
        images: { select: { id: true } },
        items: { select: { checkType: true, status: true, remarks: true } }
      },
      orderBy: { inspectedAt: 'desc' }
    });

    const activeTickets = await prisma.ticket.findMany({
      where: { locationId: id, orgId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      select: { id: true, title: true, priority: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    // Build per-day breakdown
    const dailyMap = new Map();
    for (const r of inspections) {
      const dateKey = r.inspectedAt.toISOString().split('T')[0];
      if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, { count: 0, faults: 0 });
      const entry = dailyMap.get(dateKey);
      entry.count++;
      entry.faults += r.faultyCount;
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const dailyStatus = [];
    for (let i = 0; i < days; i++) {
      const d2 = new Date();
      d2.setDate(d2.getDate() - i);
      const dateKey = d2.toISOString().split('T')[0];
      const data = dailyMap.get(dateKey) || { count: 0, faults: 0 };

      let status;
      if (data.count === 0) status = dateKey <= todayStr ? 'NOT_INSPECTED' : 'UPCOMING';
      else if (data.faults > 0) status = 'HAS_FAULTS';
      else status = 'INSPECTED';

      dailyStatus.push({
        date: dateKey,
        status,
        inspections: data.count,
        faults: data.faults
      });
    }

    return {
      location: {
        id: location.id,
        name: location.name,
        type: location.type,
        parentName: location.parent?.name || null
      },
      dailyStatus,
      recentInspections: inspections.slice(0, 10).map(r => ({
        id: r.id,
        shift: r.shift,
        inspectedAt: r.inspectedAt,
        status: r.status,
        faultyCount: r.faultyCount,
        supervisor: r.supervisor?.name || null,
        workers: r.workers.map(w => w.name),
        notes: r.notes,
        imageCount: r.images.length,
        items: r.items
      })),
      activeTickets,
      days
    };
  });
}

module.exports = analyticsRoutes;
