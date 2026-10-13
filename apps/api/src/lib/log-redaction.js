'use strict';

/**
 * Keep credentials out of logs, alerts and error.log. [WP-A]
 *
 * This app carries credentials in URLs in several places — `?token=` on the SSE streams
 * and the /images/ proxy (an <img> or EventSource cannot send an Authorization header),
 * the token as a path segment on /review/:token, and `?token=` on the emailed reset links.
 * So a raw URL is never safe to log. Everything that logs or alerts describes a request by
 * its route template (`/review/:token`), falling back to the path with the query removed.
 *
 * Serializers rather than pino `redact`: redact matches known key paths, but the leak here
 * is inside a string value (the URL), which only a serializer can rewrite.
 */

function stripQuery(url) {
  if (typeof url !== 'string') return '';
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function routeOrPath(request) {
  const template = request && request.routeOptions && request.routeOptions.url;
  return template || stripQuery(request && request.url);
}

function describeTarget(request) {
  return `${(request && request.method) || 'UNKNOWN'} ${routeOrPath(request)}`;
}

const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_PARAM = /\b([A-Za-z_]*token)=([^&\s"'<>]+)/gi;

function scrubJwtShapes(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(JWT_SHAPE, '[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(TOKEN_PARAM, '$1=[REDACTED]');
}

const serializers = {
  req(request) {
    return {
      method: request.method,
      url: routeOrPath(request),
      hostname: request.hostname,
      remoteAddress: request.ip,
      remotePort: request.socket ? request.socket.remotePort : undefined
    };
  },
  url(value) {
    return stripQuery(String(value));
  },
  // An error message or stack can embed a URL or token (e.g. a thrown message quoting the
  // request); scrub both rather than trusting every throw site.
  err(error) {
    if (!error || typeof error !== 'object') return error;
    const out = {
      type: error.constructor ? error.constructor.name : 'Error',
      message: scrubJwtShapes(error.message),
      stack: scrubJwtShapes(error.stack)
    };
    if (error.code !== undefined) out.code = error.code;
    if (error.statusCode !== undefined) out.statusCode = error.statusCode;
    return out;
  }
};

// Serializers only reach object fields. When an Error is the first argument, pino copies its
// message into the top-level `msg` string, which no serializer sees — so every log call is
// also routed through this hook: a leading Error moves under `err` (serialized above) and
// every string argument, including the message, is scrubbed.
function scrubLogArgs(args) {
  const out = Array.from(args);
  if (out[0] instanceof Error) {
    const err = out[0];
    out[0] = { err };
    if (typeof out[1] !== 'string') out.splice(1, 0, err.message);
  }
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i] === 'string') out[i] = scrubJwtShapes(out[i]);
  }
  return out;
}

/** Merge the redacting serializers and hook into pino options without dropping the caller's own. */
function buildLoggerOptions(base = {}) {
  const callerLogMethod = base.hooks && base.hooks.logMethod;
  return {
    ...base,
    serializers: { ...(base.serializers || {}), ...serializers },
    hooks: {
      ...(base.hooks || {}),
      logMethod(args, method, level) {
        const scrubbed = scrubLogArgs(args);
        return callerLogMethod ? callerLogMethod.call(this, scrubbed, method, level) : method.apply(this, scrubbed);
      }
    }
  };
}

module.exports = { stripQuery, describeTarget, scrubJwtShapes, buildLoggerOptions };
