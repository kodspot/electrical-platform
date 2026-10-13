'use strict';

// WP-A: src/lib/log-redaction.js — the helpers that keep credentials carried in URLs
// (?token=…, path tokens) and JWT-shaped strings out of logs, alerts and error.log.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { stripQuery, describeTarget, scrubJwtShapes, buildLoggerOptions } = require('../src/lib/log-redaction');

const CANARY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOiJ3cC1hIn0.Q2FuYXJ5U2lnbmF0dXJlV1BB';

describe('WP-A log redaction — stripQuery', () => {
  it('drops everything from the first "?" for every query shape', () => {
    const cases = [
      [`/api/notifications/worker-stream?token=${CANARY_JWT}`, '/api/notifications/worker-stream'],
      [`/images/uploads/o/x.webp?token=${CANARY_JWT}&token=${CANARY_JWT}`, '/images/uploads/o/x.webp'],
      [`/a?ToKeN=${CANARY_JWT}`, '/a'],
      [`/a?%74oken=${CANARY_JWT}`, '/a'],
      [`/a??token=${CANARY_JWT}`, '/a'],
      ['/a?token', '/a'],
      [`/a?=${CANARY_JWT}`, '/a'],
      [`/reset-password?token=${CANARY_JWT}`, '/reset-password'],
      ['/plain/path', '/plain/path'],
      ['', ''],
      [undefined, '']
    ];
    for (const [input, expected] of cases) assert.strictEqual(stripQuery(input), expected, String(input));
  });
});

describe('WP-A log redaction — describeTarget', () => {
  it('prefers the route template, so path tokens never appear', () => {
    const req = { method: 'GET', url: `/review/${CANARY_JWT}?x=1`, routeOptions: { url: '/review/:token' } };
    assert.strictEqual(describeTarget(req), 'GET /review/:token');
  });

  it('falls back to the path without its query when there is no route template', () => {
    const req = { method: 'GET', url: `/reset-password?token=${CANARY_JWT}`, routeOptions: {} };
    assert.strictEqual(describeTarget(req), 'GET /reset-password');
  });

  it('never throws on a partial request object', () => {
    assert.strictEqual(describeTarget({}), 'UNKNOWN ');
    assert.strictEqual(describeTarget(null), 'UNKNOWN ');
  });
});

describe('WP-A log redaction — scrubJwtShapes', () => {
  it('redacts JWTs, bearer tokens and token= values, case-insensitively', () => {
    const text = `boom ${CANARY_JWT} | Authorization: Bearer abcdefgh12345678 | ?ToKeN=abc123&access_token=xyz789`;
    const out = scrubJwtShapes(text);
    assert.ok(!out.includes(CANARY_JWT));
    assert.ok(!out.includes('abcdefgh12345678'));
    assert.ok(!out.includes('abc123') && !out.includes('xyz789'));
    assert.match(out, /\[REDACTED\]/);
  });

  it('leaves ordinary text and non-strings alone', () => {
    assert.strictEqual(scrubJwtShapes('Cannot read properties of undefined (reading "id")'), 'Cannot read properties of undefined (reading "id")');
    assert.strictEqual(scrubJwtShapes(undefined), undefined);
  });
});

describe('WP-A log redaction — buildLoggerOptions', () => {
  it('keeps the caller\'s options and merges (not replaces) their serializers', () => {
    const custom = () => 'kept';
    const opts = buildLoggerOptions({ level: 'warn', serializers: { res: custom } });
    assert.strictEqual(opts.level, 'warn');
    assert.strictEqual(opts.serializers.res, custom);
    assert.strictEqual(typeof opts.serializers.req, 'function');
    assert.strictEqual(typeof opts.serializers.url, 'function');
    assert.strictEqual(typeof opts.serializers.err, 'function');
  });

  it('the logMethod hook scrubs the message pino derives from a leading Error, and every string argument', () => {
    const calls = [];
    const method = function (...args) { calls.push(args); };
    const { hooks } = buildLoggerOptions({});
    hooks.logMethod([new Error(`failed ${CANARY_JWT}`)], method, 50);
    hooks.logMethod([{ a: 1 }, `msg with ${CANARY_JWT}`, `extra ?token=${CANARY_JWT}`], method, 30);
    assert.ok(!JSON.stringify(calls.map((c) => c.filter((x) => typeof x === 'string'))).includes(CANARY_JWT));
    assert.ok(calls[0][0].err instanceof Error, 'a leading Error is moved under err for the err serializer');
    assert.strictEqual(calls[0][1], 'failed [REDACTED]');
  });

  it('composes with a caller-supplied logMethod hook instead of replacing it', () => {
    const seen = [];
    const { hooks } = buildLoggerOptions({ hooks: { logMethod(args, method) { seen.push(args[0]); return method.apply(this, args); } } });
    hooks.logMethod([`x ${CANARY_JWT}`], () => {}, 30);
    assert.deepStrictEqual(seen, ['x [REDACTED]']);
  });

  it('req, url and err serializers emit no query string, path token or JWT', () => {
    const { serializers } = buildLoggerOptions({});
    const req = serializers.req({
      method: 'GET', url: `/review/${CANARY_JWT}?token=${CANARY_JWT}`, routeOptions: { url: '/review/:token' },
      hostname: 'localhost', ip: '127.0.0.1', socket: { remotePort: 5555 }
    });
    assert.deepStrictEqual(req, { method: 'GET', url: '/review/:token', hostname: 'localhost', remoteAddress: '127.0.0.1', remotePort: 5555 });
    assert.strictEqual(serializers.url(`/x?token=${CANARY_JWT}`), '/x');
    const err = serializers.err(new Error(`failed for ${CANARY_JWT}`));
    assert.ok(!JSON.stringify(err).includes(CANARY_JWT));
    assert.strictEqual(err.type, 'Error');
  });
});
