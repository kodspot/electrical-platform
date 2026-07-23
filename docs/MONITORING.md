# Monitoring & Observability

The operational view: what to watch, what "healthy" looks like, and where the signals are.
This is the *operations* perspective — for *how* the underlying mechanisms work (circuit
breakers, schedulers, error handling), see
[`architecture/resilience.md`](architecture/resilience.md); for the alerting env vars, see
[`reference/environment.md`](reference/environment.md).

## Health endpoints

Two endpoints, deliberately different (`apps/api/src/routes/health.js`):

| Endpoint | Status codes | Meaning | Used by |
|---|---|---|---|
| `GET /health` | always `200` | **Liveness** + a quick status body | anything that only needs "is it running" |
| `GET /health/live` | always `200` | **Liveness only** (no dependency check) | orchestrators that must not restart on a DB outage |
| `GET /health/ready` | `200` / `503` | **Readiness** — the database is actually reachable | Docker `HEALTHCHECK`, the deploy gate, Caddy's `depends_on` |
| `GET /health/info` | always `200` | **Operational diagnostics** (build, deps, config) | operators diagnosing "what's deployed / why isn't X working" |

**Deploys and container orchestration must gate on `/health/ready`, not `/health`** — an
always-200 endpoint cannot tell you the app is actually serving traffic. Both endpoints
include live circuit-breaker status (`circuitBreakers.database`, `circuitBreakers.aiProvider`)
so their state is visible without shelling into the container.

### `/health/info` — operational diagnostics

A lightweight, **secret-free** summary of what an instance is and how it's configured, from
the single source of truth `apps/api/src/lib/diagnostics.js` (the same data logged once at
startup — see [Logs](#logs)):

- **`build`** — version, commit/build metadata (if `GIT_SHA`/`BUILD_TIME` are set),
  Node version, `environment` (`NODE_ENV`), `storageDriver`, start time, and uptime.
- **`dependencies`** — database status, both circuit-breaker states, and live SSE connection
  counts.
- **`configuration`** — booleans only (never secret values) for which optional integrations
  are configured: `email`, `globalAiKey`, `errorAlerting`, `ipHashPepper`. This turns
  "why isn't email/AI/alerting working?" into a single glance.

## Request correlation

Every response carries an **`x-request-id`** header (the app's own request id). Server logs
are already tagged with the same id (pino's request-scoped logger), and every error response
body includes it as `requestId` — so a client-reported request or error can be traced to its
exact log lines. When someone reports a problem, ask for the `x-request-id` (or the
`requestId` from the error body) and grep the logs for it.

## Slow-request logging

Requests slower than a threshold (default 2000ms, `SLOW_REQUEST_MS`) are logged at `warn`
with the request id, method, path, status, and duration (`apps/api/src/plugins/observability.js`).
This surfaces production latency problems **without** enabling per-request logging (which
stays off at scale). Long-lived SSE streams are excluded so they aren't mistaken for slow
requests.

### What healthy looks like

- `/health/ready` → `200` with `database: connected`.
- `circuitBreakers.database.state: CLOSED` with a low/zero recent-failure count.
- `circuitBreakers.aiProvider.state: CLOSED` (or `OPEN` only transiently during a real
  provider outage — that is the breaker doing its job, see
  [runbooks](RUNBOOKS.md#ai-provider-outage)).

## Error alerting

The global error handler (`apps/api/src/errors.js`) logs every 5xx and can push an alert to
Telegram and/or a generic webhook. It is **best-effort, debounced per route, and never
blocks a response**. It only fires if configured:

- Set `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`, and/or `ALERT_WEBHOOK_URL`
  (see [`reference/environment.md`](reference/environment.md)).
- **If unset, alerting silently no-ops** — errors reach only the log file below. As of the
  2026-07 audit this was unconfigured in the reviewed environment (finding H2,
  [`history/production-readiness-audit-2026-07.md`](history/production-readiness-audit-2026-07.md)).
  Configuring at least one channel before go-live is strongly recommended.

## Logs

- **Application error log:** `data/logs/error.log` inside the container (mounted to the
  `app-logs` volume). Size-capped at 50 MB with automatic truncation (`errors.js`), so it
  cannot fill the disk.
- **Request/lifecycle logs:** pino to stdout, captured by Docker. Level is `warn` in
  production (per-request `info` noise is suppressed at scale), so startup, shutdown, and
  scheduler-coordination events are logged at `warn` deliberately to remain visible.
- **Startup runtime-configuration summary:** on boot, one `warn` line
  (`[startup] runtime configuration`) records the same `build` + `configuration` data
  `/health/info` serves — so the deployed version and which integrations are configured are
  visible in the logs immediately, without hitting an endpoint.
- Retrieve with `docker compose logs api` (the deploy script already dumps the last 150
  lines on a failed health check).

## What is *not* monitored (known gaps)

There is **no external APM or uptime monitor** beyond the health endpoints and Docker's
healthcheck-driven restart policy — reasonable for the current single-VM scale, but a
conscious gap: nothing pages a human on a sustained outage unless error alerting is
configured. See the audit snapshot for the full list.

## Related

- Mechanisms: [`architecture/resilience.md`](architecture/resilience.md)
- Incident response: [`RUNBOOKS.md`](RUNBOOKS.md)
- Env vars: [`reference/environment.md`](reference/environment.md)
- Known gaps: [`history/production-readiness-audit-2026-07.md`](history/production-readiness-audit-2026-07.md)
