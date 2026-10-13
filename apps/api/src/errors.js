const path = require('path');
const { appendFile, mkdir, stat, truncate } = require('fs/promises');
const { isProduction } = require('./config/env');
const { describeTarget, scrubJwtShapes } = require('./lib/log-redaction');

// Maximum error log size in bytes (50 MB) — auto-truncated to prevent disk fill
const MAX_LOG_SIZE = 50 * 1024 * 1024;

async function logError(err) {
  try {
    const logDir = path.join(__dirname, '../../../data/logs');
    await mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, 'error.log');
    await appendFile(logPath, `[${new Date().toISOString()}] ${scrubJwtShapes(err && err.stack)}\n\n`);

    // Auto-rotate: if log exceeds MAX_LOG_SIZE, truncate to keep recent entries
    try {
      const s = await stat(logPath);
      if (s.size > MAX_LOG_SIZE) {
        await truncate(logPath, 0);
        await appendFile(logPath, `[${new Date().toISOString()}] Log rotated — previous entries cleared (exceeded ${MAX_LOG_SIZE / 1024 / 1024}MB)\n\n`);
      }
    } catch { /* stat/truncate failure is non-critical */ }
  } catch (e) {
    console.error('Failed to write to error log:', e);
  }
}

/**
 * Send a lightweight alert for server errors (5xx).
 * Supports Telegram bot webhook and/or a generic webhook URL.
 *
 * Env vars (all optional — alerting is best-effort, never blocks responses):
 *   ALERT_TELEGRAM_BOT_TOKEN — Telegram bot token
 *   ALERT_TELEGRAM_CHAT_ID  — Telegram chat/group ID
 *   ALERT_WEBHOOK_URL       — Generic POST webhook (Slack, Discord, etc.)
 */
const _alertCooldown = new Map(); // route → lastAlertTs (debounce per route)
const ALERT_COOLDOWN_MS = 60_000; // max 1 alert per route per 60 seconds

// Evict stale cooldown entries every 10 minutes to prevent unbounded growth
setInterval(() => {
  const cutoff = Date.now() - ALERT_COOLDOWN_MS * 2;
  for (const [key, ts] of _alertCooldown) {
    if (ts < cutoff) _alertCooldown.delete(key);
  }
}, 600_000).unref();

async function sendErrorAlert(error, request) {
  try {
    const telegramToken = process.env.ALERT_TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.ALERT_TELEGRAM_CHAT_ID;
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;

    if (!telegramToken && !webhookUrl) return; // alerting not configured

    // Debounce: don't spam alerts for the same route. The route template (or the path with
    // its query stripped), never the raw URL: URLs here can carry ?token= credentials. [WP-A]
    const route = describeTarget(request);
    const lastAlert = _alertCooldown.get(route) || 0;
    if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
    _alertCooldown.set(route, Date.now());

    const timestamp = new Date().toISOString();
    const statusCode = error.statusCode || 500;
    const safeMessage = scrubJwtShapes(error.message || 'Unknown error');
    const errMsg = safeMessage.slice(0, 200).replace(/[_*`[\]]/g, '\\$&');
    const message = [
      `🚨 *Server Error ${statusCode}*`,
      `Route: \`${route}\``,
      `Error: ${errMsg}`,
      `Request ID: \`${request.id}\``,
      `Time: ${timestamp}`,
      `Org: ${request.user?.orgId || 'N/A'}`
    ].join('\n');

    // Telegram notification
    if (telegramToken && telegramChatId) {
      const telegramUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
      fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramChatId, text: scrubJwtShapes(message), parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {}); // fire-and-forget
    }

    // Generic webhook (Slack, Discord, etc.)
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: scrubJwtShapes(message), error: safeMessage, route, requestId: request.id, timestamp }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {}); // fire-and-forget
    }
  } catch { /* alerting must never break the app */ }
}

function validateImageBuffer(buffer, mimetype) {
  const signatures = {
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/png': [0x89, 0x50, 0x4E, 0x47],
    'image/webp': [0x52, 0x49, 0x46, 0x46]
  };

  const sig = signatures[mimetype];
  if (!sig) return false;
  return sig.every((byte, i) => buffer[i] === byte);
}

function registerErrorHandlers(fastify) {
  fastify.setErrorHandler(async (error, request, reply) => {
    // request.log (not fastify.log) is the request-scoped child logger — it
    // automatically tags this line with request.id, so an error can be correlated
    // with its request in the logs the same way it's correlated in the response body.
    request.log.error(error);
    await logError(error);

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too many requests',
        retryAfter: error.after,
        message: `Rate limit exceeded. Retry after ${error.after}`,
        requestId: request.id
      });
    }

    // Circuit breaker tripped — service unavailable, retry later
    if (error.circuitBreaker) {
      return reply.status(503).send({
        error: 'Service temporarily unavailable',
        message: 'The system is experiencing issues. Please try again shortly.',
        retryAfter: 30,
        requestId: request.id
      });
    }

    if (error.name === 'ZodError') {
      return reply.status(400).send({
        error: 'Validation failed',
        details: error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        requestId: request.id
      });
    }

    if (error.code === 'P2002') {
      return reply.status(409).send({
        error: 'Duplicate entry',
        message: 'A record with this value already exists',
        requestId: request.id
      });
    }

    if (error.code?.startsWith('P')) {
      sendErrorAlert(error, request); // non-blocking alert
      return reply.status(500).send({
        error: 'Database error',
        message: isProduction ? 'Internal server error' : error.message,
        requestId: request.id
      });
    }

    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      sendErrorAlert(error, request); // non-blocking alert
    }

    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : (error.code || 'Error'),
      message: (isProduction && statusCode >= 500) ? 'Something went wrong' : error.message,
      requestId: request.id
    });
  });

  const fs = require('fs');
  const path = require('path');
  const publicDir = path.join(__dirname, '..', 'public');

  fastify.setNotFoundHandler((request, reply) => {
    // Clean URL support: /admin-login → /admin-login.html
    if (request.method === 'GET') {
      const cleanPath = request.url.split('?')[0].replace(/^\//, '');

      // /scan/CODE → serve scan.html (smart QR landing page)
      if (cleanPath.startsWith('scan/')) {
        return reply.sendFile('scan.html');
      }

      if (cleanPath && !cleanPath.includes('.') && fs.existsSync(path.join(publicDir, cleanPath + '.html'))) {
        return reply.sendFile(cleanPath + '.html');
      }
    }
    reply.status(404).send({ error: 'Not found', message: `Route ${request.method} ${request.url} not found`, requestId: request.id });
  });
}

module.exports = { logError, validateImageBuffer, registerErrorHandlers };
