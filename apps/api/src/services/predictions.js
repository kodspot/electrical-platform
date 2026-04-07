'use strict';

/**
 * Predictive Maintenance & Anomaly Detection Service
 *
 * Analyses historical inspection data, failure patterns, and asset lifecycle
 * to predict potential failures and detect anomalies before they occur.
 *
 * Features:
 *  - Asset risk scoring based on failure history, age, and maintenance gaps
 *  - Anomaly detection via statistical deviation from baselines
 *  - AI-powered failure prediction using LLM analysis
 *  - Trend forecasting from historical data
 */

const { prisma } = require('../lib/prisma');
const { aiBreaker } = require('../lib/circuit-breaker');

// Re-use AI callers from automation service
const automationPath = require.resolve('./automation');
let _automationModule = null;
function getAutomation() {
  if (!_automationModule) _automationModule = require(automationPath);
  return _automationModule;
}

// ─────────────────────────────────────────────
// 1. ASSET RISK SCORING
// ─────────────────────────────────────────────

/**
 * Calculate a risk score (0-100) for each active asset in the org.
 * Factors:
 *   - Failure frequency (last 90 days)
 *   - Average time between failures (MTBF)
 *   - Overdue maintenance
 *   - Asset age
 *   - Current condition/status
 *   - Trend of inspection faults related to the asset's location
 */
async function calculateAssetRiskScores(orgId) {
  const now = new Date();
  const d90 = new Date(now); d90.setDate(now.getDate() - 90);
  const d180 = new Date(now); d180.setDate(now.getDate() - 180);

  // Fetch assets with their recent failures and events
  const assets = await prisma.asset.findMany({
    where: { orgId, isActive: true },
    select: {
      id: true, assetCode: true, name: true, category: true,
      status: true, condition: true,
      installDate: true, lastMaintenanceAt: true, nextMaintenanceDue: true,
      maintenanceCycleDays: true, locationId: true,
      failures: {
        where: { failedAt: { gte: d180 } },
        select: { id: true, severity: true, status: true, failedAt: true, resolvedAt: true, downtime: true },
        orderBy: { failedAt: 'desc' }
      },
      events: {
        where: { eventDate: { gte: d90 } },
        select: { type: true, eventDate: true, conditionAfter: true },
        orderBy: { eventDate: 'desc' },
        take: 20
      }
    }
  });

  // Fetch location-level inspection fault rates for context
  const locationFaults = await prisma.electricalInspection.groupBy({
    by: ['locationId'],
    where: { orgId, inspectedAt: { gte: d90 } },
    _count: true,
    _sum: { faultyCount: true }
  });
  const faultMap = {};
  locationFaults.forEach(lf => {
    faultMap[lf.locationId] = {
      inspections: lf._count,
      faults: lf._sum.faultyCount || 0
    };
  });

  return assets.map(asset => {
    let score = 0;
    const factors = [];

    // 1. Failure frequency (0-30 points)
    const recent90 = asset.failures.filter(f => f.failedAt >= d90);
    const failureCount = recent90.length;
    if (failureCount >= 5) { score += 30; factors.push('High failure frequency (5+ in 90 days)'); }
    else if (failureCount >= 3) { score += 20; factors.push('Elevated failure frequency (3-4 in 90 days)'); }
    else if (failureCount >= 1) { score += 10; factors.push(`${failureCount} failure(s) in 90 days`); }

    // 2. Critical/high failures (0-15 points)
    const criticals = recent90.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
    if (criticals.length > 0) { score += Math.min(criticals.length * 5, 15); factors.push(`${criticals.length} critical/high severity failure(s)`); }

    // 3. Overdue maintenance (0-15 points)
    if (asset.nextMaintenanceDue && asset.nextMaintenanceDue < now) {
      const overdueDays = Math.floor((now - asset.nextMaintenanceDue) / 86400000);
      if (overdueDays > 30) { score += 15; factors.push(`Maintenance overdue by ${overdueDays} days`); }
      else if (overdueDays > 7) { score += 10; factors.push(`Maintenance overdue by ${overdueDays} days`); }
      else { score += 5; factors.push('Maintenance slightly overdue'); }
    }

    // 4. Current condition/status (0-15 points)
    if (asset.condition === 'CRITICAL') { score += 15; factors.push('Asset condition is CRITICAL'); }
    else if (asset.condition === 'POOR') { score += 10; factors.push('Asset condition is POOR'); }
    else if (asset.condition === 'FAIR') { score += 5; factors.push('Asset condition is FAIR'); }

    if (asset.status === 'UNDER_REPAIR') { score += 5; factors.push('Currently under repair'); }
    else if (asset.status === 'OUT_OF_SERVICE') { score += 10; factors.push('Currently out of service'); }

    // 5. Asset age (0-10 points)
    if (asset.installDate) {
      const ageYears = (now - asset.installDate) / (365.25 * 86400000);
      if (ageYears > 10) { score += 10; factors.push(`Asset age: ${Math.round(ageYears)} years`); }
      else if (ageYears > 5) { score += 5; factors.push(`Asset age: ${Math.round(ageYears)} years`); }
    }

    // 6. Location fault rate (0-10 points)
    const locData = faultMap[asset.locationId];
    if (locData && locData.inspections > 0) {
      const faultRate = locData.faults / locData.inspections;
      if (faultRate > 2) { score += 10; factors.push('Location has high fault rate'); }
      else if (faultRate > 0.5) { score += 5; factors.push('Location has elevated fault rate'); }
    }

    // 7. Mean time between failures (bonus penalty)
    if (asset.failures.length >= 2) {
      const sorted = asset.failures.slice().sort((a, b) => a.failedAt - b.failedAt);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push((sorted[i].failedAt - sorted[i - 1].failedAt) / 86400000);
      }
      const mtbf = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (mtbf < 7) { score += 5; factors.push(`MTBF only ${Math.round(mtbf)} days — very frequent`); }
    }

    score = Math.min(score, 100);

    const riskLevel = score >= 70 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';

    return {
      assetId: asset.id,
      assetCode: asset.assetCode,
      name: asset.name,
      category: asset.category,
      status: asset.status,
      condition: asset.condition,
      riskScore: score,
      riskLevel,
      factors,
      failureCount90d: failureCount,
      totalFailures180d: asset.failures.length,
      maintenanceOverdue: asset.nextMaintenanceDue ? asset.nextMaintenanceDue < now : false,
      lastMaintenanceAt: asset.lastMaintenanceAt,
      nextMaintenanceDue: asset.nextMaintenanceDue
    };
  }).sort((a, b) => b.riskScore - a.riskScore);
}

// ─────────────────────────────────────────────
// 2. ANOMALY DETECTION
// ─────────────────────────────────────────────

/**
 * Detect anomalies by comparing recent metrics against historical baselines.
 * Returns an array of detected anomalies with severity and description.
 */
async function detectAnomalies(orgId) {
  const now = new Date();
  const d7 = new Date(now); d7.setDate(now.getDate() - 7);
  const d30 = new Date(now); d30.setDate(now.getDate() - 30);
  const d90 = new Date(now); d90.setDate(now.getDate() - 90);

  const anomalies = [];

  // 1. Inspection completion rate anomaly
  const [recent7, baseline30] = await Promise.all([
    prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: d7 } } }),
    prisma.electricalInspection.count({ where: { orgId, inspectedAt: { gte: d30, lt: d7 } } })
  ]);
  const avgWeekly30 = baseline30 / (23 / 7); // ~3.3 weeks in 23-day baseline
  if (avgWeekly30 > 0 && recent7 < avgWeekly30 * 0.5) {
    anomalies.push({
      type: 'INSPECTION_DROP',
      severity: 'HIGH',
      title: 'Inspection completion dropped significantly',
      description: `Only ${recent7} inspections in the last 7 days vs. ${Math.round(avgWeekly30)} weekly average.`,
      metric: { recent: recent7, baseline: Math.round(avgWeekly30) }
    });
  }

  // 2. Fault rate spike
  const [recentFaults, baselineFaults] = await Promise.all([
    prisma.electricalInspection.aggregate({ where: { orgId, inspectedAt: { gte: d7 } }, _sum: { faultyCount: true } }),
    prisma.electricalInspection.aggregate({ where: { orgId, inspectedAt: { gte: d30, lt: d7 } }, _sum: { faultyCount: true } })
  ]);
  const recentFaultTotal = recentFaults._sum.faultyCount || 0;
  const baselineFaultAvg = (baselineFaults._sum.faultyCount || 0) / (23 / 7);
  if (baselineFaultAvg > 0 && recentFaultTotal > baselineFaultAvg * 2) {
    anomalies.push({
      type: 'FAULT_SPIKE',
      severity: 'HIGH',
      title: 'Fault rate has spiked',
      description: `${recentFaultTotal} faults in 7 days vs. ${Math.round(baselineFaultAvg)} weekly average (2x+ increase).`,
      metric: { recent: recentFaultTotal, baseline: Math.round(baselineFaultAvg) }
    });
  }

  // 3. Failure surge
  const [recentFailures, baselineFailures] = await Promise.all([
    prisma.assetFailure.count({ where: { orgId, failedAt: { gte: d7 } } }),
    prisma.assetFailure.count({ where: { orgId, failedAt: { gte: d30, lt: d7 } } })
  ]);
  const avgWeeklyFailures = baselineFailures / (23 / 7);
  if (avgWeeklyFailures > 0 && recentFailures > avgWeeklyFailures * 2) {
    anomalies.push({
      type: 'FAILURE_SURGE',
      severity: 'CRITICAL',
      title: 'Asset failure rate has surged',
      description: `${recentFailures} failures in 7 days vs. ${Math.round(avgWeeklyFailures)} weekly average.`,
      metric: { recent: recentFailures, baseline: Math.round(avgWeeklyFailures) }
    });
  }

  // 4. Repeat failures — same asset failing multiple times
  const repeatAssets = await prisma.assetFailure.groupBy({
    by: ['assetId'],
    where: { orgId, failedAt: { gte: d30 } },
    _count: true,
    having: { assetId: { _count: { gte: 3 } } }
  });
  for (const rpt of repeatAssets) {
    const asset = await prisma.asset.findUnique({ where: { id: rpt.assetId }, select: { assetCode: true, name: true } });
    anomalies.push({
      type: 'REPEAT_FAILURE',
      severity: 'HIGH',
      title: `Repeat failures: ${asset?.assetCode || rpt.assetId}`,
      description: `${asset?.name || 'Asset'} (${asset?.assetCode || '?'}) has failed ${rpt._count} times in 30 days. Investigate root cause.`,
      metric: { assetId: rpt.assetId, failureCount: rpt._count }
    });
  }

  // 5. Attendance anomaly
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const [totalWorkers, absentToday] = await Promise.all([
    prisma.worker.count({ where: { orgId, isActive: true } }),
    prisma.attendance.count({ where: { orgId, date: todayStart, status: 'ABSENT' } })
  ]);
  if (totalWorkers > 0 && absentToday / totalWorkers > 0.3) {
    anomalies.push({
      type: 'HIGH_ABSENTEEISM',
      severity: 'MEDIUM',
      title: 'High absenteeism detected',
      description: `${absentToday}/${totalWorkers} workers absent today (${Math.round(absentToday / totalWorkers * 100)}%).`,
      metric: { absent: absentToday, total: totalWorkers }
    });
  }

  return anomalies;
}

// ─────────────────────────────────────────────
// 3. AI-POWERED FAILURE PREDICTION
// ─────────────────────────────────────────────

/**
 * Use AI to analyse top-risk assets and generate actionable predictions.
 * Calls the configured AI provider through the circuit breaker.
 */
async function generatePredictions(orgId, logger) {
  // Lazy-require to avoid circular deps
  const auto = getAutomation();
  const resolveAiCredentials = auto.resolveAiCredentials;
  const callAiProvider = auto.callAiProvider;

  if (!resolveAiCredentials || !callAiProvider) {
    if (logger) logger.warn('AI functions not available — skipping AI predictions');
    return null;
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, aiApiKey: true, aiProvider: true, aiModel: true }
  });
  if (!org) return null;

  const creds = resolveAiCredentials(org);
  if (!creds) return null;

  // Gather risk data
  const riskScores = await calculateAssetRiskScores(orgId);
  const topRisk = riskScores.slice(0, 10);
  const anomalies = await detectAnomalies(orgId);

  if (topRisk.length === 0 && anomalies.length === 0) {
    return { summary: 'No significant risks detected. All assets operating within normal parameters.', predictions: [], anomalies: [] };
  }

  const systemPrompt = `You are an electrical infrastructure predictive maintenance AI assistant. Analyse the provided asset risk data and anomalies to generate actionable predictions.

For each high-risk asset, predict:
1. Likelihood of failure in the next 7/30 days (LOW/MEDIUM/HIGH/CRITICAL)
2. Recommended preventive action
3. Estimated urgency (hours/days/weeks)

Format response as JSON:
{
  "summary": "Brief overall assessment (2-3 sentences)",
  "predictions": [
    {
      "assetCode": "...",
      "assetName": "...",
      "failureProbability7d": "LOW|MEDIUM|HIGH|CRITICAL",
      "failureProbability30d": "LOW|MEDIUM|HIGH|CRITICAL",
      "recommendedAction": "...",
      "urgency": "immediate|days|weeks",
      "reasoning": "..."
    }
  ],
  "anomalyInsights": "Brief analysis of detected anomalies and their implications"
}

Be concise and actionable. Focus on electrical infrastructure (transformers, panels, generators, motors, cables, UPS).`;

  const userMessage = `TOP RISK ASSETS:
${topRisk.map(a => `- ${a.assetCode} (${a.name}) [${a.category}]: Risk ${a.riskScore}/100 (${a.riskLevel})
  Condition: ${a.condition}, Status: ${a.status}
  Failures (90d): ${a.failureCount90d}, Maintenance overdue: ${a.maintenanceOverdue}
  Factors: ${a.factors.join('; ')}`).join('\n')}

DETECTED ANOMALIES:
${anomalies.length > 0 ? anomalies.map(a => `- [${a.severity}] ${a.title}: ${a.description}`).join('\n') : 'None'}`;

  try {
    const result = await aiBreaker.exec(() => callAiProvider(creds, systemPrompt, userMessage, 1500));

    // Try to parse JSON from response
    let parsed;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: result.content, predictions: [] };
    } catch {
      parsed = { summary: result.content, predictions: [] };
    }

    return {
      ...parsed,
      riskScores: topRisk,
      anomalies,
      generatedAt: new Date().toISOString(),
      tokensUsed: result.totalTokens || 0
    };
  } catch (err) {
    if (logger) logger.error({ err }, 'AI prediction generation failed');
    // Return risk scores and anomalies without AI analysis
    return {
      summary: 'AI analysis unavailable. Risk scores calculated from historical data.',
      predictions: [],
      riskScores: topRisk,
      anomalies,
      generatedAt: new Date().toISOString(),
      aiError: true
    };
  }
}

// ─────────────────────────────────────────────
// 4. TREND ANALYSIS
// ─────────────────────────────────────────────

/**
 * Generate trend data for charting — fault rate, failure rate, inspection completion
 * over the last N weeks.
 */
async function getTrends(orgId, weeks = 12) {
  const now = new Date();
  const trends = [];

  for (let w = 0; w < weeks; w++) {
    const weekEnd = new Date(now); weekEnd.setDate(now.getDate() - w * 7);
    const weekStart = new Date(weekEnd); weekStart.setDate(weekEnd.getDate() - 7);

    const [inspections, faults, failures] = await Promise.all([
      prisma.electricalInspection.count({
        where: { orgId, inspectedAt: { gte: weekStart, lt: weekEnd } }
      }),
      prisma.electricalInspection.aggregate({
        where: { orgId, inspectedAt: { gte: weekStart, lt: weekEnd } },
        _sum: { faultyCount: true }
      }),
      prisma.assetFailure.count({
        where: { orgId, failedAt: { gte: weekStart, lt: weekEnd } }
      })
    ]);

    trends.unshift({
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: weekEnd.toISOString().slice(0, 10),
      inspections,
      faults: faults._sum.faultyCount || 0,
      failures,
      faultRate: inspections > 0 ? Math.round((faults._sum.faultyCount || 0) / inspections * 100) / 100 : 0
    });
  }

  return trends;
}

module.exports = {
  calculateAssetRiskScores,
  detectAnomalies,
  generatePredictions,
  getTrends
};
