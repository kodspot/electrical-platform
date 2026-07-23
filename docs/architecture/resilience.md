# Resilience & Background Work

The system's defenses against dependency failure, and how its scheduled jobs stay correct.
Much of this is invisible in normal operation, which is exactly why it needs documenting —
a maintainer must not accidentally remove or bypass it. The governing rule is Charter §8.3:
*resilience infrastructure must actually be wired in, not just built.*

## Circuit breakers

`lib/circuit-breaker.js` implements a `CircuitBreaker` state machine
(`CLOSED → OPEN → HALF_OPEN → CLOSED`) with two shared singletons:

- **`dbBreaker`** — protects the database. It is wired into **every** Prisma operation
  automatically via a Prisma Client Extension in `lib/prisma.js` (`$extends` wrapping
  `$allOperations` in `dbBreaker.exec`). No route file opts in; they all use the shared
  `prisma` export and get fast-fail-on-outage for free. Scope note: the extension covers
  per-model operations (`findMany`/`create`/…) but not `$queryRaw`/`$transaction` as
  top-level client methods — each statement *inside* a `$transaction` callback is still
  covered because `tx` inherits the extension.
- **`aiBreaker`** — protects AI-provider calls. It is wrapped **inside** the shared
  `callAiProvider` (`lib/ai-provider.js`), so every AI caller (the `/ai/*` endpoints,
  automation's daily insight, predictions) is protected without each remembering to wrap
  its own call.

The design principle (Charter §8.3–§8.4, from `[WP12]`/`[WP10]`): **bake resilience into a
shared primitive so a caller cannot forget it**, rather than requiring each call site to opt
in. Both breakers' live status is reported on `/health`.

## Scheduler locks (cross-instance safety)

`lib/scheduler-lock.js` provides `runExclusive(prisma, lockKey, jobFn, logger)` using
**PostgreSQL advisory locks** (`pg_try_advisory_xact_lock`) — no Redis or new infra, since
the database is already shared. Each logical scheduled job has a fixed integer key in
`LOCK_KEYS`. If more than one instance ever runs, only the instance that wins the lock runs
a given tick; the others skip it (not a queue — a skipped tick is caught by the next
interval, which is safe because every job only acts on rows past an age cutoff).

Why transaction-scoped (`xact`) locks specifically: with a pooled Prisma client, a
session-scoped lock/unlock pair could run on two different pooled connections and leak the
lock. A transaction-scoped lock releases automatically when its transaction ends, and the
job runs *inside* that transaction's callback (holding the lock for the job's full
duration) while still using the normal `prisma` client for its own queries. The transaction
timeout is raised to 5 minutes for this reason — headroom, not an expected duration.

## Scheduled jobs

Two `setInterval`-based schedulers start after boot (`apps/api/index.js`), each job wrapped
in `runExclusive` + try/catch so one failure never crashes the scheduler:

| Job | Scheduler | Cadence | Lock key |
|---|---|---|---|
| Image retention cleanup (30-day) | `services/cleanup.js` | daily | `IMAGE_CLEANUP` |
| Guest-PII anonymization (180-day) | `services/cleanup.js` | daily | `GUEST_ANONYMIZATION` |
| Default template seeding | `services/cleanup.js` | at startup | `TEMPLATE_SEEDING` |
| Scheduled alert checks (missed/overdue) | `services/automation.js` | 30 min | `SCHEDULED_CHECKS` |
| Escalation checks | `services/automation.js` | 5 min | `ESCALATION_CHECKS` |
| Daily AI insights | `services/automation.js` | daily window | `AI_DAILY_INSIGHTS` |
| Alert/insight retention cleanup (90-day) | `services/automation.js` | daily | `ALERT_INSIGHT_CLEANUP` |

Missed-inspection alerting reads each org's configured `ShiftConfig` (via the shared
`services/shift-config.js`) rather than a hardcoded deadline table, so orgs with custom
shift windows get correctly-timed alerts (Charter §8.4, `[WP10]`). Alerts deduplicate per
calendar day (`fireAlert`'s `dedupKey`), which is what makes a re-run of a skipped tick
safe.

All scheduler timer handles are returned to `index.js` and cleared on `SIGINT`/`SIGTERM`
for a clean graceful shutdown.

## Error handling & process safety

`apps/api/src/errors.js`:
- A global Fastify error handler logs 5xx errors to `data/logs/error.log` (size-capped,
  auto-rotated) and can send an alert (Telegram/webhook) if `ALERT_*` env vars are set —
  best-effort, debounced per route, never blocking a response.
- `index.js` handles **both** `unhandledRejection` (log, keep running) and
  `uncaughtException` (log, then exit — a process in an undefined state is not safe to
  resume; Charter §8.3, `[WP12]`).

## Connection resilience

`connectWithRetry` (`lib/prisma.js`) retries the initial DB connection with exponential
backoff + jitter, so a slow-to-start database doesn't fail the boot. Pool sizing defaults
to `connection_limit=10` (see [`../SCALING.md`](../SCALING.md) for tuning with multiple
instances).

## Related

- [overview.md](overview.md) · [data-model.md](data-model.md)
- Ops view: [`../operations`](../README.md#operations--run-recover-scale),
  known risks: [`../history/production-readiness-audit-2026-07.md`](../history/production-readiness-audit-2026-07.md)
- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §8.3, §8.4
- Tests: `apps/api/test/integration/resilience-circuit-breakers.test.js`,
  `scheduler-lock.test.js`
