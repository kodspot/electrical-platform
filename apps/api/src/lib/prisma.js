'use strict';

const { PrismaClient } = require('@prisma/client');
const { dbBreaker } = require('./circuit-breaker');

const isProduction = process.env.NODE_ENV === 'production';

// Append connection pool params to DATABASE_URL if not already set
function buildDatabaseUrl() {
  const base = process.env.DATABASE_URL || '';
  if (!base) return base;
  // If user already specified pool params, don't override
  if (base.includes('connection_limit') || base.includes('pool_timeout')) return base;
  const sep = base.includes('?') ? '&' : '?';
  // connection_limit=10 gives a healthy pool for a single-instance VM
  // pool_timeout=10 prevents connections from blocking too long
  return `${base}${sep}connection_limit=10&pool_timeout=10`;
}

const rawPrismaClient = new PrismaClient({
  log: isProduction ? ['error'] : ['query', 'info', 'warn', 'error'],
  datasources: {
    db: {
      url: buildDatabaseUrl()
    }
  }
});

// Route every query through the database circuit breaker transparently, so
// every route file gets fast-fail-on-outage behavior for free without
// changing any of them. Previously dbBreaker existed and was even reported
// on /health, but nothing ever called it — every route hit Prisma directly,
// so a real DB outage would still queue up requests against a known-down
// database instead of fast-failing, and /health's circuitBreakers.database
// field could never reflect reality (always CLOSED, 0 failures). $extends
// preserves $connect/$disconnect/$transaction/$queryRaw as normal top-level
// client methods — only per-model operations (findMany/create/update/...)
// are wrapped; raw queries and the transaction boundary itself are not
// individually gated by this (see docs/ENGINEERING_CHARTER.md §12). [WP12]
const prisma = rawPrismaClient.$extends({
  name: 'db-circuit-breaker',
  query: {
    async $allOperations({ query, args }) {
      return dbBreaker.exec(() => query(args));
    }
  }
});

/**
 * Connect with exponential backoff + jitter.
 * delay(i) = baseDelay * 2^i + random(0..baseDelay)
 */
async function connectWithRetry(logger, retries = 5, baseDelay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await prisma.$connect();
      logger.info('✅ Database connected successfully');
      return;
    } catch (err) {
      logger.error(`Database connection attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * baseDelay;
      logger.info(`Retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

module.exports = { prisma, connectWithRetry };
