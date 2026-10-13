'use strict';

const path = require('path');

// The browser helpers (public/js/app.js apiFetch/saFetch/elecFetch) always send
// Content-Type: application/json, so a POST/PATCH with no body (Pick Up, acknowledge, mark
// read, …) arrives as JSON with an empty body — which Fastify's default parser rejects with
// 400 FST_ERR_CTP_EMPTY_JSON_BODY before auth runs. An empty or whitespace-only JSON body is
// therefore read as {}; everything else goes to Fastify's own parser unchanged, so
// prototype-poisoning protection and the body limit (server-wide or per-route) still apply.
// Fixed here rather than in app.js so browsers holding a cached app.js work too. [F14]
function registerJsonParser(fastify) {
  const defaultJsonParser = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, {});
    return defaultJsonParser(request, body, done);
  });
}

async function registerContentPlugins(fastify) {
  registerJsonParser(fastify);

  await fastify.register(require('@fastify/multipart'), {
    attachFieldsToBody: true,
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 5,
      fields: 10
    }
  });

  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/',
    decorateReply: true
  });
}

module.exports = { registerContentPlugins };
