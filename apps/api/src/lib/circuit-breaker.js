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
 */

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string}  opts.name             — Identifier for logging
   * @param {number}  opts.failureThreshold — Failures before opening (default 5)
   * @param {number}  opts.cooldownMs       — How long the circuit stays open (default 30s)
   * @param {number}  opts.monitorWindowMs  — Sliding window for failure counting (default 60s)
   */
  constructor(opts = {}) {
    this.name = opts.name || 'default';
    this.failureThreshold = opts.failureThreshold || 5;
    this.cooldownMs = opts.cooldownMs || 30_000;
    this.monitorWindowMs = opts.monitorWindowMs || 60_000;

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
      this.onFailure();
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

// Singleton breakers for the app
const dbBreaker = new CircuitBreaker({
  name: 'database',
  failureThreshold: 5,
  cooldownMs: 30_000,
  monitorWindowMs: 60_000
});

const aiBreaker = new CircuitBreaker({
  name: 'ai-provider',
  failureThreshold: 3,
  cooldownMs: 60_000,
  monitorWindowMs: 120_000
});

module.exports = { CircuitBreaker, dbBreaker, aiBreaker, STATE };
