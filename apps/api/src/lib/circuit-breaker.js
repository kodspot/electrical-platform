'use strict';

/**
 * Lightweight circuit breaker for database and external service calls.
 *
 * States:
 *   CLOSED  → Normal operation, requests pass through
 *   OPEN    → Circuit tripped, requests fast-fail without hitting the service
 *   HALF_OPEN → After cooldown, one probe request allowed to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN         when failureCount >= failureThreshold
 *   OPEN → HALF_OPEN      after cooldownMs has elapsed
 *   HALF_OPEN → CLOSED    on success (resets counters)
 *   HALF_OPEN → OPEN      on failure (resets cooldown timer)
 *
 * Only errors that `isFailure(err)` accepts count as failures. Every error still
 * reaches the caller; an error that does not count simply says nothing about the
 * dependency's health. The default counts every error (aiBreaker); dbBreaker counts
 * only infrastructure failures — see isDbInfrastructureError. [F15]
 */

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string}  opts.name             — Identifier for logging
   * @param {number}  opts.failureThreshold — Failures before opening (default 5)
   * @param {number}  opts.cooldownMs       — How long the circuit stays open (default 30s)
   * @param {number}  opts.monitorWindowMs  — Sliding window for failure counting (default 60s)
   * @param {(err: Error) => boolean} [opts.isFailure] — Which errors count (default: all)
   */
  constructor(opts = {}) {
    this.name = opts.name || 'default';
    this.failureThreshold = opts.failureThreshold || 5;
    this.cooldownMs = opts.cooldownMs || 30_000;
    this.monitorWindowMs = opts.monitorWindowMs || 60_000;
    this.isFailure = opts.isFailure || (() => true);

    this.state = STATE.CLOSED;
    this.failures = [];      // timestamps of recent failures
    this.lastOpenedAt = 0;
    this.successCount = 0;
    this.totalFailures = 0;
  }

  /** Prune old failure timestamps outside the monitor window */
  _pruneFailures() {
    const cutoff = Date.now() - this.monitorWindowMs;
    this.failures = this.failures.filter(t => t > cutoff);
  }

  /** Record a successful call */
  onSuccess() {
    this.successCount++;
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.CLOSED;
      this.failures = [];
    }
  }

  /** Record a failed call */
  onFailure() {
    this.totalFailures++;
    this.failures.push(Date.now());
    this._pruneFailures();

    if (this.state === STATE.HALF_OPEN) {
      // Probe failed — reopen
      this.state = STATE.OPEN;
      this.lastOpenedAt = Date.now();
      return;
    }

    if (this.failures.length >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.lastOpenedAt = Date.now();
    }
  }

  /**
   * An error that does not count. If it was the HALF_OPEN probe, the probe proved
   * nothing either way: release the probe slot so the next request probes instead
   * (otherwise the breaker would wait in HALF_OPEN with no probe in flight, forever).
   */
  onIgnoredError() {
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.OPEN;
      this.lastOpenedAt = Date.now() - this.cooldownMs;
    }
  }

  /** Check whether a request should be allowed through */
  allowRequest() {
    if (this.state === STATE.CLOSED) return true;

    if (this.state === STATE.OPEN) {
      // Check if cooldown has passed → transition to HALF_OPEN
      if (Date.now() - this.lastOpenedAt >= this.cooldownMs) {
        this.state = STATE.HALF_OPEN;
        return true; // allow one probe request
      }
      return false;
    }

    // HALF_OPEN — only one probe should pass (already allowed when transitioning)
    return false;
  }

  /** Execute fn through the circuit breaker */
  async exec(fn) {
    if (!this.allowRequest()) {
      const err = new Error(`Circuit breaker "${this.name}" is OPEN — request rejected`);
      err.circuitBreaker = true;
      err.statusCode = 503;
      throw err;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure();
      else this.onIgnoredError();
      throw err;
    }
  }

  /** Get current status (for health endpoint) */
  getStatus() {
    this._pruneFailures();
    return {
      name: this.name,
      state: this.state,
      recentFailures: this.failures.length,
      totalFailures: this.totalFailures,
      totalSuccesses: this.successCount,
      lastOpenedAt: this.lastOpenedAt ? new Date(this.lastOpenedAt).toISOString() : null
    };
  }
}

// Prisma error codes that mean the database itself is unreachable or exhausted:
// P1001 can't reach server, P1002 server timed out, P1008 operation timed out,
// P1017 server closed the connection, P2024 timed out waiting for a pool connection.
const DB_INFRA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const NET_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

/**
 * Does this error say the database is down? Only these open dbBreaker. [F15]
 *
 * Everything else — a validation error from a bad query shape, a unique-constraint
 * violation (P2002), a missing record (P2025), any other P2xxx — is a property of one
 * request, not of the database, and still throws to the caller but never counts.
 * Counting them let ordinary request errors (an electrician's photo loads) open the
 * breaker and take the whole platform to 503.
 *
 * PrismaClientUnknownRequestError does NOT count: the engine reached the database and
 * got an answer it could not map to a code (typically a query-level database error).
 * It says the request failed, not that the database is unavailable; a real outage
 * surfaces as an initialization error, P1001/P1002/P1008/P1017/P2024, or a network
 * error, all of which count.
 */
function isDbInfrastructureError(err) {
  if (!err) return false;
  if (err.name === 'PrismaClientInitializationError' || err.name === 'PrismaClientRustPanicError') return true;
  if (err.name === 'PrismaClientKnownRequestError') return DB_INFRA_CODES.has(err.code);
  if (NET_ERROR_CODES.has(err.code) || NET_ERROR_CODES.has(err.cause?.code)) return true;
  return false;
}

// Singleton breakers for the app
const dbBreaker = new CircuitBreaker({
  name: 'database',
  failureThreshold: 5,
  cooldownMs: 30_000,
  monitorWindowMs: 60_000,
  isFailure: isDbInfrastructureError
});

const aiBreaker = new CircuitBreaker({
  name: 'ai-provider',
  failureThreshold: 3,
  cooldownMs: 60_000,
  monitorWindowMs: 120_000
});

module.exports = { CircuitBreaker, dbBreaker, aiBreaker, STATE, isDbInfrastructureError };
