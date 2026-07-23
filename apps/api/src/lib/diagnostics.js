'use strict';

/**
 * Operational diagnostics — the single source of truth for "what is this running
 * instance and how is it configured". [platform-M6]
 *
 * Consumed by the /health/info endpoint (routes/health.js) and the startup summary log
 * (index.js), so both report identical information. Contains NO secret values — only a
 * version, environment name, and presence booleans — so it is always safe to log or
 * expose on a health endpoint.
 */

const pkg = require('../../package.json');

// Captured once at module load — the process start time, for uptime reporting.
const startedAt = new Date();

/** Version / build / runtime metadata. */
function buildInfo() {
  return {
    version: process.env.npm_package_version || pkg.version || 'unknown',
    // Optional — set these at build/deploy time to correlate a running instance with a commit.
    commit: process.env.GIT_SHA || process.env.GIT_COMMIT || null,
    buildTime: process.env.BUILD_TIME || null,
    node: process.version,
    environment: process.env.NODE_ENV || 'development',
    storageDriver: (process.env.STORAGE_DRIVER || 'r2').toLowerCase(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime())
  };
}

/**
 * Which optional integrations are configured, as booleans only (never a secret value).
 * Turns "why isn't email/AI/alerting working?" into a single glance at /health/info.
 */
function configStatus() {
  const has = (...keys) => keys.every((k) => !!process.env[k]);
  return {
    email: has('SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASS'),
    globalAiKey: has('GLOBAL_AI_API_KEY'),
    errorAlerting: !!(process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID) || !!process.env.ALERT_WEBHOOK_URL,
    ipHashPepper: has('IP_HASH_PEPPER')
  };
}

module.exports = { buildInfo, configStatus };
