'use strict';

const path = require('path');
const { isProduction, APP_URL } = require('../config/env');
const { COOKIE_CONFIG } = require('../lib/security');

async function registerSecurityPlugins(fastify) {
  const corsOriginsConfigured = !!process.env.CORS_ORIGINS;
  const allowedOrigins = corsOriginsConfigured
    ? process.env.CORS_ORIGINS.split(',').map(url => url.trim())
    : [APP_URL];

  // Restrict to the configured origin list whenever one is explicitly set, not only
  // in production — an operator who sets CORS_ORIGINS clearly intends restriction,
  // and a non-production environment that forgets NODE_ENV=production but did set
  // CORS_ORIGINS should still get it enforced. Pure local dev (neither set) keeps
  // the permissive default so no extra setup is needed to hack on the app.
  await fastify.register(require('@fastify/cors'), {
    origin: (isProduction || corsOriginsConfigured) ? allowedOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Org-Id']
  });

  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false, // required for external font loading
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    dnsPrefetchControl: { allow: false },
    hsts: isProduction ? {
      maxAge: 63072000, // 2 years (stronger than 1 year)
      includeSubDomains: true,
      preload: true
    } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' }
  });

  await fastify.register(require('@fastify/rate-limit'), {
    max: parseInt(process.env.RATE_LIMIT_MAX) || 1000,
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry in ${context.after}`,
      retryAfter: context.after
    })
  });

  await fastify.register(require('@fastify/cookie'), {
    // COOKIE_SECRET is unconditionally required (config/env.js REQUIRED_ENV), so no
    // fallback is needed here — reusing JWT_SECRET for a different purpose if this
    // were ever unset would be a secret-reuse anti-pattern, not a safe default.
    secret: process.env.COOKIE_SECRET,
    parseOptions: COOKIE_CONFIG
  });
}

module.exports = { registerSecurityPlugins };
