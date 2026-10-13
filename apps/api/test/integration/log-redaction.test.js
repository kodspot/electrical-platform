'use strict';

// WP-A: credentials carried in URLs must never reach a log, an alert or error.log.
// Builds the real app (buildApp/registerApp) with a capturing log stream, adds two
// test-only routes to THIS instance only (a slow one and a throwing one), and fires
// requests carrying a canary JWT in every URL shape this app uses for tokens. Needs no
// database: every request here is answered before any query.

// Must be set before index.js loads (observability.js reads it once at load time).
process.env.SLOW_REQUEST_MS = '1';
process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests-min32chars';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-for-unit-tests';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');

const { buildApp, registerApp } = require('../../index');

const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOiJ3cC1hIn0.Q2FuYXJ5U2lnbmF0dXJlV1BB';
const CANARY_FRAGMENTS = [CANARY_JWT, 'Q2FuYXJ5U2lnbmF0dXJlV1BB', 'eyJjYW5hcnkiOiJ3cC1hIn0'];
const ERROR_LOG = path.join(__dirname, '..', '..', '..', '..', 'data', 'logs', 'error.log');

function captureStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); }
  });
  return { stream, text: () => lines.join('') };
}

const leaked = (text) => CANARY_FRAGMENTS.filter((f) => text.includes(f));

// Every URL shape that can carry a credential in this codebase.
const URLS = [
  `/api/notifications/worker-stream?token=${CANARY_JWT}`,
  `/api/notifications/stream?token=${CANARY_JWT}`,
  `/images/uploads/org/x.webp?token=${CANARY_JWT}`,
  `/review/${CANARY_JWT}`,
  `/reset-password?token=${CANARY_JWT}`,
  `/worker-reset-pin?token=${CANARY_JWT}`,
  `/api/notifications/worker-stream?ToKeN=${CANARY_JWT}&token=${CANARY_JWT}`,
  `/api/notifications/worker-stream?%74oken=${CANARY_JWT}`,
  `/api/notifications/worker-stream??token=${CANARY_JWT}`,
  `/api/notifications/worker-stream?=${CANARY_JWT}`,
  '/api/notifications/worker-stream?token'
];

describe('WP-A — no credential reaches a log line, alert or error.log', () => {
  let app;
  let logs;
  const alertBodies = [];
  const realFetch = globalThis.fetch;
  let errorLogSizeBefore = 0;

  before(async () => {
    logs = captureStream();
    // A caller-supplied logger object: buildApp must merge the redacting serializers into it.
    app = buildApp({ logger: { level: 'info', stream: logs.stream } });
    await registerApp(app);
    app.get('/__qa/sleep', async () => { await new Promise((r) => setTimeout(r, 15)); return { ok: true }; });
    app.get('/__qa/boom', async () => { throw new Error(`boom while handling ${CANARY_JWT}`); });
    await app.ready();

    // Alerting is blanked by the test guard; enable it in-process with dummy endpoints and
    // capture what would be sent instead of sending it.
    process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/hook';
    process.env.ALERT_TELEGRAM_BOT_TOKEN = 'dummy-bot-token';
    process.env.ALERT_TELEGRAM_CHAT_ID = 'dummy-chat';
    globalThis.fetch = async (_url, init) => {
      alertBodies.push(String(init && init.body));
      return new Response('{}', { status: 200 });
    };
    try { errorLogSizeBefore = fs.statSync(ERROR_LOG).size; } catch { errorLogSizeBefore = 0; }
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const k of ['ALERT_WEBHOOK_URL', 'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID']) process.env[k] = '';
    if (app) await app.close();
  });

  it('Fastify request lines carry no query string or path token, for every token URL shape', async () => {
    for (const url of URLS) await app.inject({ method: 'GET', url });
    const text = logs.text();
    assert.ok(text.includes('incoming request'), 'the capture must actually contain request lines');
    assert.deepStrictEqual(leaked(text), [], 'a request log line leaked the canary');
    assert.ok(text.includes('/review/:token'), 'path tokens must be logged as the route template');
  });

  it('the slow-request warning logs the route, not the URL', async () => {
    await app.inject({ method: 'GET', url: `/__qa/sleep?token=${CANARY_JWT}` });
    const slow = logs.text().split('\n').filter((l) => l.includes('slow request'));
    assert.ok(slow.length > 0, 'expected a slow-request line with SLOW_REQUEST_MS=1');
    assert.deepStrictEqual(leaked(slow.join('\n')), []);
    assert.ok(slow.some((l) => l.includes('/__qa/sleep')));
  });

  it('a 5xx keeps the canary out of request.log.error, both alert bodies, and error.log', async () => {
    const res = await app.inject({ method: 'GET', url: `/__qa/boom?token=${CANARY_JWT}` });
    assert.strictEqual(res.statusCode, 500);
    // Alerts are fire-and-forget; let the stubbed fetch calls settle.
    await new Promise((r) => setImmediate(r));

    // Without a database, /reset-password (matched by the /:orgSlug page route) also 500s and
    // alerts — so count only this route's alerts, but check EVERY alert body for the canary.
    const boomAlerts = alertBodies.filter((b) => b.includes('/__qa/boom'));
    assert.strictEqual(boomAlerts.length, 2, 'expected one Telegram and one webhook alert naming the route');
    assert.deepStrictEqual(leaked(alertBodies.join('\n')), [], 'an alert body leaked the canary');

    const errorLines = logs.text().split('\n').filter((l) => l.includes('"level":50'));
    assert.ok(errorLines.length > 0, 'expected a request.log.error line');
    assert.deepStrictEqual(leaked(errorLines.join('\n')), [], 'request.log.error leaked the canary');

    let appended = '';
    for (let i = 0; i < 50 && !appended.includes('boom'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      try { appended = fs.readFileSync(ERROR_LOG, 'utf8').slice(errorLogSizeBefore); } catch { appended = ''; }
    }
    assert.ok(appended.includes('boom while handling'), 'error.log must still record the error');
    assert.deepStrictEqual(leaked(appended), [], 'error.log leaked the canary');
  });
});

describe('WP-A — control: an unpatched Fastify logger does leak', () => {
  it('logs the raw URL, query token included', async () => {
    const logs = captureStream();
    const raw = require('fastify')({ logger: { level: 'info', stream: logs.stream } });
    raw.get('/x', async () => ({ ok: true }));
    await raw.inject({ method: 'GET', url: `/x?token=${CANARY_JWT}` });
    await raw.close();
    assert.ok(logs.text().includes(CANARY_JWT), 'the control must show the leak this work package closes');
  });
});
