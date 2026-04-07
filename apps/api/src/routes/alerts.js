'use strict';

const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');
const { generateAiInsights, runScheduledChecks, runEscalationChecks } = require('../services/automation');

const VALID_TRIGGERS = [
  'INSPECTION_FAULT', 'INSPECTION_LATE', 'INSPECTION_MISSED',
  'ASSET_FAILURE_REPORTED', 'ASSET_FAILURE_UNRESOLVED',
  'ASSET_MAINTENANCE_OVERDUE', 'TICKET_HIGH_PRIORITY', 'ATTENDANCE_LOW'
];
const VALID_ACTIONS = ['NOTIFY_ADMINS', 'NOTIFY_SUPERVISORS', 'NOTIFY_ASSIGNED_WORKERS', 'NOTIFY_ASSIGNED_SUPERVISORS', 'CREATE_TICKET'];

async function alertRoutes(fastify) {
  fastify.addHook('preHandler', authenticateJWT);

  // ═══════════════════════════════════════════
  // ALERT RULES — CRUD
  // ═══════════════════════════════════════════

  // ── List rules ──
  fastify.get('/alert-rules', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { trigger, active } = request.query;

    const where = { orgId };
    if (trigger && VALID_TRIGGERS.includes(trigger)) where.trigger = trigger;
    if (active === 'true') where.isActive = true;
    if (active === 'false') where.isActive = false;

    const rules = await prisma.alertRule.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { alerts: true } } }
    });

    return { rules };
  });

  // ── Get single rule ──
  fastify.get('/alert-rules/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const rule = await prisma.alertRule.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: { _count: { select: { alerts: true } } }
    });
    if (!rule) return reply.code(404).send({ error: 'Rule not found' });
    return rule;
  });

  // ── Create rule ──
  const createRuleSchema = z.object({
    name: z.string().min(1).max(200).trim(),
    description: z.string().max(1000).optional(),
    trigger: z.enum(VALID_TRIGGERS),
    conditions: z.record(z.unknown()).default({}),
    actions: z.array(z.object({
      type: z.enum(VALID_ACTIONS),
      priority: z.string().optional()
    })).min(1).max(5),
    isActive: z.boolean().default(true),
    escalateAfterMinutes: z.number().int().min(1).max(10080).optional().nullable(),
    escalationActions: z.array(z.object({
      type: z.enum(VALID_ACTIONS),
      priority: z.string().optional()
    })).max(5).optional().nullable(),
    maxEscalations: z.number().int().min(1).max(10).optional().nullable()
  });

  fastify.post('/alert-rules', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const data = createRuleSchema.parse(request.body);
    const orgId = request.user.orgId;

    const rule = await prisma.alertRule.create({
      data: {
        orgId,
        name: data.name,
        description: data.description || null,
        trigger: data.trigger,
        conditions: data.conditions,
        actions: data.actions,
        isActive: data.isActive,
        escalateAfterMinutes: data.escalateAfterMinutes || null,
        escalationActions: data.escalationActions || null,
        maxEscalations: data.maxEscalations || null
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'alert_rule_created',
        entityType: 'AlertRule',
        entityId: rule.id,
        newValue: { name: rule.name, trigger: rule.trigger }
      }
    });

    return reply.code(201).send(rule);
  });

  // ── Update rule ──
  const updateRuleSchema = z.object({
    name: z.string().min(1).max(200).trim().optional(),
    description: z.string().max(1000).optional().nullable(),
    conditions: z.record(z.unknown()).optional(),
    actions: z.array(z.object({
      type: z.enum(VALID_ACTIONS),
      priority: z.string().optional()
    })).min(1).max(5).optional(),
    isActive: z.boolean().optional(),
    escalateAfterMinutes: z.number().int().min(1).max(10080).optional().nullable(),
    escalationActions: z.array(z.object({
      type: z.enum(VALID_ACTIONS),
      priority: z.string().optional()
    })).max(5).optional().nullable(),
    maxEscalations: z.number().int().min(1).max(10).optional().nullable()
  });

  fastify.patch('/alert-rules/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const data = updateRuleSchema.parse(request.body);
    const orgId = request.user.orgId;

    const existing = await prisma.alertRule.findFirst({
      where: { id: request.params.id, orgId }
    });
    if (!existing) return reply.code(404).send({ error: 'Rule not found' });

    const update = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.conditions !== undefined) update.conditions = data.conditions;
    if (data.actions !== undefined) update.actions = data.actions;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.escalateAfterMinutes !== undefined) update.escalateAfterMinutes = data.escalateAfterMinutes;
    if (data.escalationActions !== undefined) update.escalationActions = data.escalationActions;
    if (data.maxEscalations !== undefined) update.maxEscalations = data.maxEscalations;

    const rule = await prisma.alertRule.update({
      where: { id: existing.id },
      data: update
    });

    return rule;
  });

  // ── Delete rule ──
  fastify.delete('/alert-rules/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const existing = await prisma.alertRule.findFirst({
      where: { id: request.params.id, orgId }
    });
    if (!existing) return reply.code(404).send({ error: 'Rule not found' });

    await prisma.alertRule.delete({ where: { id: existing.id } });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: 'user',
        actorId: request.user.id,
        action: 'alert_rule_deleted',
        entityType: 'AlertRule',
        entityId: existing.id,
        oldValue: { name: existing.name, trigger: existing.trigger }
      }
    });

    return { success: true };
  });

  // ═══════════════════════════════════════════
  // ALERT HISTORY
  // ═══════════════════════════════════════════

  // ── List alerts ──
  fastify.get('/alerts', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { trigger, severity, acknowledged, from, to, page, limit } = request.query;

    const where = { orgId };
    if (trigger && VALID_TRIGGERS.includes(trigger)) where.trigger = trigger;
    if (severity) where.severity = severity;
    if (acknowledged === 'true') where.acknowledged = true;
    if (acknowledged === 'false') where.acknowledged = false;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        if (to.length === 10) toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [alerts, total, unacknowledged] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { rule: { select: { name: true } } }
      }),
      prisma.alert.count({ where }),
      prisma.alert.count({ where: { orgId, acknowledged: false } })
    ]);

    // Stats for filter summary
    const stats = await prisma.alert.groupBy({
      by: ['severity'],
      where: { orgId, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      _count: true
    });

    return {
      alerts,
      total,
      pages: Math.ceil(total / take),
      unacknowledged,
      stats: Object.fromEntries(stats.map(s => [s.severity, s._count]))
    };
  });

  // ── Get single alert ──
  fastify.get('/alerts/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const alert = await prisma.alert.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId },
      include: { rule: { select: { name: true, trigger: true, conditions: true } } }
    });
    if (!alert) return reply.code(404).send({ error: 'Alert not found' });
    return alert;
  });

  // ── Acknowledge alert ──
  fastify.patch('/alerts/:id/acknowledge', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const alert = await prisma.alert.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId }
    });
    if (!alert) return reply.code(404).send({ error: 'Alert not found' });
    if (alert.acknowledged) return reply.code(400).send({ error: 'Already acknowledged' });

    const updated = await prisma.alert.update({
      where: { id: alert.id },
      data: {
        acknowledged: true,
        acknowledgedBy: request.user.id,
        acknowledgedAt: new Date()
      }
    });
    return updated;
  });

  // ── Acknowledge all unacknowledged ──
  fastify.patch('/alerts/acknowledge-all', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const result = await prisma.alert.updateMany({
      where: { orgId: request.user.orgId, acknowledged: false },
      data: {
        acknowledged: true,
        acknowledgedBy: request.user.id,
        acknowledgedAt: new Date()
      }
    });
    return { success: true, count: result.count };
  });

  // ── Alert summary (dashboard widget) ──
  fastify.get('/alerts/summary', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    const [totalUnack, todayCount, weekCount, bySeverity, byTrigger] = await Promise.all([
      prisma.alert.count({ where: { orgId, acknowledged: false } }),
      prisma.alert.count({ where: { orgId, createdAt: { gte: todayStart } } }),
      prisma.alert.count({ where: { orgId, createdAt: { gte: weekAgo } } }),
      prisma.alert.groupBy({
        by: ['severity'],
        where: { orgId, acknowledged: false },
        _count: true
      }),
      prisma.alert.groupBy({
        by: ['trigger'],
        where: { orgId, createdAt: { gte: weekAgo } },
        _count: true
      })
    ]);

    return {
      unacknowledged: totalUnack,
      today: todayCount,
      thisWeek: weekCount,
      bySeverity: Object.fromEntries(bySeverity.map(s => [s.severity, s._count])),
      byTrigger: Object.fromEntries(byTrigger.map(t => [t.trigger, t._count]))
    };
  });

  // ═══════════════════════════════════════════
  // AI INSIGHTS
  // ═══════════════════════════════════════════

  // ── List insights ──
  fastify.get('/ai-insights', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const { type, page, limit } = request.query;

    const where = { orgId };
    if (type) where.type = type;

    const take = Math.min(parseInt(limit) || 20, 50);
    const skip = ((parseInt(page) || 1) - 1) * take;

    const [insights, total, unread] = await Promise.all([
      prisma.aiInsight.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.aiInsight.count({ where }),
      prisma.aiInsight.count({ where: { orgId, isRead: false } })
    ]);

    return { insights, total, pages: Math.ceil(total / take), unread };
  });

  // ── Get single insight ──
  fastify.get('/ai-insights/:id', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const insight = await prisma.aiInsight.findFirst({
      where: { id: request.params.id, orgId: request.user.orgId }
    });
    if (!insight) return reply.code(404).send({ error: 'Insight not found' });

    // Auto-mark as read
    if (!insight.isRead) {
      await prisma.aiInsight.update({ where: { id: insight.id }, data: { isRead: true } });
      insight.isRead = true;
    }

    return insight;
  });

  // ── Trigger insight generation now (admin manual trigger) ──
  fastify.post('/ai-insights/generate', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const org = await prisma.organization.findUnique({
      where: { id: request.user.orgId },
      select: {
        id: true, name: true, type: true, enabledModules: true,
        aiEnabled: true, aiProvider: true, aiModel: true, aiApiKey: true,
        aiMonthlyTokenLimit: true, aiTotalTokensUsed: true
      }
    });

    if (!org || !org.aiEnabled) {
      return reply.code(400).send({ error: 'AI is not enabled for this organization' });
    }

    // Run in background (don't block the response)
    generateAiInsights(fastify.log).catch(err =>
      fastify.log.error({ err }, 'Manual AI insight generation failed')
    );

    return { success: true, message: 'Insight generation started. Check back in a moment.' };
  });

  // ── Trigger scheduled checks now (admin manual trigger) ──
  fastify.post('/alerts/run-checks', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    runScheduledChecks(fastify.log).catch(err =>
      fastify.log.error({ err }, 'Manual scheduled check failed')
    );
    return { success: true, message: 'Scheduled rule checks started.' };
  });

  // ── Trigger escalation checks now (admin manual trigger) ──
  fastify.post('/alerts/run-escalations', {
    preHandler: [requireRole('ADMIN')]
  }, async (request) => {
    runEscalationChecks(fastify.log).catch(err =>
      fastify.log.error({ err }, 'Manual escalation check failed')
    );
    return { success: true, message: 'Escalation checks started.' };
  });
}

module.exports = alertRoutes;
