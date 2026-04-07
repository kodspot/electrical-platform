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

const prisma = new PrismaClient({
  log: isProduction ? ['error'] : ['query', 'info', 'warn', 'error'],
  datasources: {
    db: {
      url: buildDatabaseUrl()
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

/**
 * Execute a Prisma operation through the database circuit breaker.
 * Use for critical read paths where you want fast-fail on DB outage.
 */
async function dbExec(fn) {
  return dbBreaker.exec(fn);
}

module.exports = { prisma, connectWithRetry, dbExec };
