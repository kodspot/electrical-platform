# High Availability & Horizontal Scalability

This document is the plan referenced by Work Package 6 (Execution Plan / Release
Strategy): a precise account of what's already safe to run on more than one instance,
what this work package fixed, what still isn't safe and why, and what would be needed
to actually do it. Per the Release Strategy, full multi-instance *execution* is v2.0,
growth-triggered work — this is the readiness assessment and the incremental fixes
that don't require new infrastructure.

## Already safe for multiple instances (no change made — already correct)

- **Authentication is fully stateless.** Every request carries its own JWT bearer
  token; there is no server-side session store of any kind. Any instance can validate
  any request with no coordination with any other instance. This is the single most
  important property for horizontal scaling, and it was already true.
- **File storage is already externalized.** Uploads go to Cloudflare R2, not local
  disk (`src/lib/r2.js`) — any instance can read/write any file; nothing is pinned to
  the instance that originally handled the upload.
- **The database is the shared state layer**, as it should be — tenant data, tickets,
  audit logs, etc. all live in Postgres, not in any instance's memory.
- **`ensureModuleRegistry()` is already race-safe.** It uses Prisma's `upsert()`
  (`INSERT ... ON CONFLICT DO UPDATE` under the hood), so multiple instances cold-
  booting simultaneously — e.g. a rolling deploy — cannot corrupt or duplicate module
  registry rows. Checked specifically for this work package; no change was needed.
- **Startup already correctly gates on dependencies.** `fastify.listen()` only runs
  after the database connection and module registry are confirmed, so a new instance
  won't accept traffic before it's actually ready — and `/health/ready` (added in
  WP3) reports the same thing to an external load balancer.

## Fixed in this work package

- **Scheduled background jobs now have cross-instance duplicate-execution
  protection** (`src/lib/scheduler-lock.js`). Previously, every instance would run
  its own independent `setInterval` timers for cleanup, alert evaluation, escalation
  checks, and AI insight generation — with more than one instance, every one of them
  would have executed on every tick. Now each tick is gated by a PostgreSQL advisory
  lock (`pg_try_advisory_xact_lock`, transaction-scoped so it can't leak across a
  pooled connection): only one instance actually runs a given job; others skip that
  tick and pick it up on the next one. This uses only the database every instance
  already requires — no new infrastructure. Verified empirically (not just reasoned
  about) with two independent `PrismaClient` connections racing for the same lock —
  see the WP6 completion report's Regression Results.
- **Graceful shutdown now actually clears scheduler timers.** `startCleanupScheduler`
  and `startAutomationScheduler` always returned their interval/timeout handles, but
  `index.js` never captured or cleared them — a real gap, not previously visible,
  found while reviewing this exact area for WP6. Fixed: all timer handles are now
  captured and cleared before the server closes on `SIGINT`/`SIGTERM`.
- **Connection pool sizing for multiple instances is now documented** — it was
  already configurable (via `connection_limit`/`pool_timeout` query params on
  `DATABASE_URL`, see `src/lib/prisma.js`), but that capability wasn't written down
  anywhere. See "Scaling checklist" below and the comment now in `.env.example`.

## Not yet safe for multiple instances — and why

These are genuine architectural gaps, not oversights left unfixed by accident. Each
would require either new infrastructure (crossing this work package's explicit
boundary) or a more invasive change than "extend the existing implementation" allows.
Documented here, not fixed, per WP6's scope.

| Component | File | Why it's not multi-instance-safe |
|---|---|---|
| **Realtime notifications (SSE)** | `src/services/sse.js` | Connection registry is an in-process `Map`. A client connected to instance A never receives a push notification triggered by an action on instance B. **This is the most significant gap.** |
| Global rate limiting | `src/plugins/security.js` (`@fastify/rate-limit`) | Default in-memory store — each instance tracks its own counters, so a client's effective rate limit scales with instance count instead of staying fixed. Degraded, not broken (still slows abuse, just less precisely). |
| Circuit breakers | `src/lib/circuit-breaker.js` | Each instance tracks its own failure history independently — not incorrect, just not globally coordinated (one instance could be OPEN while another is CLOSED for the same dependency). |
| Error-alert debounce | `src/errors.js` (`_alertCooldown` Map) | Per-instance cooldown — under multi-instance, the same alert could be sent once per instance within the debounce window instead of once total. Operational noise, not a correctness issue. |
| Per-instance in-memory shift-config cache | `src/routes/electrical.js` | 5-minute cache — briefly inconsistent reads across instances if a shift config changes, self-corrects within 5 minutes. Low stakes. |

## What closing the SSE gap would actually require

Two realistic paths, both requiring architecture-level work out of WP6's scope:

1. **Redis pub/sub** — the conventional solution. Each instance subscribes to a
   shared channel; a `pushNotification`/`pushAlert` call publishes to Redis instead
   of (or in addition to) the local in-memory registry, and every instance forwards
   matching messages to its own locally-connected clients. Requires operating a Redis
   instance — new infrastructure, explicitly out of scope here.
2. **PostgreSQL `LISTEN`/`NOTIFY`** — a lower-complexity alternative that uses only
   the database already in the stack. Each instance holds one dedicated `LISTEN`
   connection and forwards `NOTIFY` payloads to its local SSE clients. No new
   infrastructure, but it's a real architectural change to `services/sse.js` and its
   callers (a dedicated, non-pooled connection per instance, payload size limits on
   `NOTIFY`, handling reconnection of the listener itself) — enough to be a
   dedicated, deliberately-scoped work package rather than a WP6 extension.

Either way, once implemented, an SSE-connected client's HTTP connection would still
need **session affinity** at the load balancer (see below) unless the fan-out layer
itself removes that requirement — pub/sub delivers the message to every instance, but
the client's actual long-lived connection is still only open to the one instance it
originally connected to.

## Scaling checklist — for when horizontal scaling is actually needed

1. **Close the SSE gap first** (see above) — everything else on this list is safe to
   do without it, but real-time notifications will silently stop working for anyone
   not connected to the "right" instance otherwise.
2. **Load balancer / reverse proxy**: any algorithm (round-robin, least-connections)
   works for ordinary API traffic, since auth is stateless. **SSE connections need
   session affinity** (IP-hash or cookie-based sticky sessions) until the gap above
   is closed — otherwise a client's SSE reconnect could land on a different instance
   than the one that knows about it.
3. **Health checks**: point the load balancer's health check at `/health/ready` (not
   `/health` — see WP3), so an instance with a broken database connection is taken
   out of rotation instead of receiving traffic it can't serve.
4. **Database connection pool**: set `connection_limit` on `DATABASE_URL` per
   instance such that `instances × connection_limit` stays comfortably under
   Postgres's `max_connections` (check with `SHOW max_connections;`). Example for 3
   instances against a default 100-connection Postgres: `connection_limit=15` leaves
   headroom for `psql`, migrations, and any other tooling.
5. **Rate limiting, circuit breakers, alert debounce**: accept the degraded (not
   broken) per-instance behavior described above, or revisit with a shared store
   (Redis, or a database-backed equivalent) if it becomes a real problem in practice
   — not a blocker for a first multi-instance deployment.
6. **Scheduled jobs**: no action needed — `src/lib/scheduler-lock.js` already
   protects against duplicate execution as of this work package.
7. **Deploy process**: `.github/workflows/deploy.yml`'s `docker compose up -d`
   currently manages a single `api` container. Running N instances means either
   `docker compose up -d --scale api=N` behind a load balancer on the same host, or
   (more realistically at that point) moving off a single-VM Compose topology
   entirely — a decision for whoever executes this, not something to prejudge here.
