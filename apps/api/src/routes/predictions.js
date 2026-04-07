'use strict';

const { authenticateJWT, requireRole } = require('../middleware/auth');
const { calculateAssetRiskScores, detectAnomalies, generatePredictions, getTrends } = require('../services/predictions');

async function predictionRoutes(fastify, opts) {

  // ── Risk Scores: All assets ranked by risk ──
  fastify.get('/predictions/risk-scores', {
    preHandler: [authenticateJWT, requireRole('ADMIN', 'SUPER_ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const scores = await calculateAssetRiskScores(orgId);
    return {
      total: scores.length,
      critical: scores.filter(s => s.riskLevel === 'CRITICAL').length,
      high: scores.filter(s => s.riskLevel === 'HIGH').length,
      medium: scores.filter(s => s.riskLevel === 'MEDIUM').length,
      low: scores.filter(s => s.riskLevel === 'LOW').length,
      assets: scores
    };
  });

  // ── Anomaly Detection ──
  fastify.get('/predictions/anomalies', {
    preHandler: [authenticateJWT, requireRole('ADMIN', 'SUPER_ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const anomalies = await detectAnomalies(orgId);
    return {
      total: anomalies.length,
      anomalies
    };
  });

  // ── AI Predictions: Full analysis with recommendations ──
  fastify.get('/predictions/ai-analysis', {
    preHandler: [authenticateJWT, requireRole('ADMIN', 'SUPER_ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const result = await generatePredictions(orgId, request.log);
    if (!result) {
      return { error: 'AI predictions not available. Configure an AI API key in organization settings.' };
    }
    return result;
  });

  // ── Trends: Historical data for charting ──
  fastify.get('/predictions/trends', {
    preHandler: [authenticateJWT, requireRole('ADMIN', 'SUPER_ADMIN')]
  }, async (request) => {
    const orgId = request.user.orgId;
    const weeks = Math.min(parseInt(request.query.weeks) || 12, 52);
    const trends = await getTrends(orgId, weeks);
    return { weeks: trends.length, trends };
  });

  // ── Single Asset Risk Detail ──
  fastify.get('/predictions/assets/:assetId', {
    preHandler: [authenticateJWT, requireRole('ADMIN', 'SUPER_ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { assetId } = request.params;
    const scores = await calculateAssetRiskScores(orgId);
    const asset = scores.find(s => s.assetId === assetId);
    if (!asset) return reply.status(404).send({ error: 'Asset not found' });
    return asset;
  });
}

module.exports = predictionRoutes;
