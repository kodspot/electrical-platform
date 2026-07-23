'use strict';

/**
 * Scenario: AI Workflow. [platform-M3, DPS §4]
 * Enables AI on the demo org and seeds one AI insight + one usage-log record. No real
 * provider call is made — these are historical records for the AI dashboard/demo.
 */

const { prisma } = require('../src/lib/prisma');

async function apply(ctx) {
  const { org, admin } = ctx['demo-organization'];

  await prisma.organization.update({
    where: { id: org.id },
    data: { aiEnabled: true, aiProvider: 'gemini', aiModel: 'gemini-2.0-flash' }
  });

  const insight = await prisma.aiInsight.create({
    data: {
      orgId: org.id,
      type: 'daily_summary',
      title: 'Daily Operations Summary',
      content: '**Overall Status: Good**\n\n- 2 inspections completed today (1 flagged for faulty wiring)\n- 3 electricians present, 1 recent absence\n- 1 high-priority ticket open in Ward 1',
      period: new Date().toISOString().slice(0, 10)
    }
  });

  const usage = await prisma.aiUsageLog.create({
    data: {
      orgId: org.id, userId: admin.id, action: 'chat',
      prompt: "How's today's inspection progress?",
      provider: 'gemini', model: 'gemini-2.0-flash',
      inputTokens: 320, outputTokens: 140, totalTokens: 460, latencyMs: 850, success: true, keySource: 'org'
    }
  });

  return { insight, usage };
}

module.exports = {
  name: 'ai-workflow',
  description: 'Enables AI on the demo org and seeds one AI insight + one usage-log record (no real API call).',
  dependsOn: ['demo-organization'],
  apply
};
