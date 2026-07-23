'use strict';

/**
 * Cross-instance duplicate-execution protection for scheduled background jobs, using
 * PostgreSQL's built-in advisory locks — no new infrastructure (Redis, etc.) required,
 * since the database is already a dependency every instance shares.
 *
 * Today, every instance runs its own independent setInterval/setTimeout timers
 * (services/cleanup.js, services/automation.js). That's harmless with exactly one
 * instance, but running more than one would mean every instance executes every
 * scheduled job on its own schedule — e.g. N instances each sending the same alert
 * evaluation, each attempting the same daily AI insight generation. This module makes
 * "only one instance actually runs this tick" a property of the job invocation itself,
 * rather than something that has to be reasoned about at every call site.
 *
 * How it works: pg_try_advisory_xact_lock() is scoped to the current transaction and
 * releases automatically when it ends — critical for correctness with a pooled Prisma
 * client, where a plain (session-scoped) pg_advisory_lock/unlock pair could easily run
 * on two different pooled connections and leak the lock. The job function itself is
 * awaited *inside* that transaction's callback, so the lock is held for the job's full
 * duration, not just an instant — but the job function keeps using the normal `prisma`
 * client for its own queries (unchanged), since the lock doesn't need to share a
 * connection with the work it's protecting, only outlive it.
 */

// Small, stable, explicit integer keys — one per logical scheduled job. Arbitrary but
// fixed values; changing one is safe (it just means in-flight locks briefly stop
// coordinating with new-code instances across a deploy), adding new ones is safe.
const LOCK_KEYS = Object.freeze({
  IMAGE_CLEANUP: 90001,
  GUEST_ANONYMIZATION: 90002,
  TEMPLATE_SEEDING: 90003,
  ALERT_INSIGHT_CLEANUP: 90004,
  SCHEDULED_CHECKS: 90005,
  ESCALATION_CHECKS: 90006,
  AI_DAILY_INSIGHTS: 90007
});

/**
 * Runs jobFn only if this instance wins the advisory-lock race for lockKey; other
 * instances calling this concurrently for the same key skip the tick instead of
 * running it too. Returns { ran: boolean, result }.
 *
 * Not a queue — a skipped tick is simply not retried early; it runs on the next
 * scheduled interval. That matches these jobs' existing idempotent, periodic nature
 * (each run only acts on rows past a cutoff, so a missed tick is caught by the next
 * one, not lost).
 */
async function runExclusive(prisma, lockKey, jobFn, logger) {
  let ran = false;
  let result;

  await prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked`;
      if (!locked) {
        // warn, not info: the production logger is 'warn'-level (see index.js), and
        // this is a coordination event worth seeing, not routine per-tick noise —
        // the same reasoning WP3 applied to startup/shutdown lifecycle logging.
        if (logger) logger.warn(`[scheduler-lock] Skipped — another instance is already running lock ${lockKey}`);
        return;
      }
      ran = true;
      result = await jobFn();
    },
    // Default Prisma transaction timeout (5s) is far too short to hold open for the
    // duration of a real job — this is generous headroom, not an expected duration.
    { timeout: 5 * 60 * 1000, maxWait: 10000 }
  );

  return { ran, result };
}

module.exports = { runExclusive, LOCK_KEYS };
