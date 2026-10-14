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
with the request id, the route (`route`: method + route template, e.g. `GET /review/:token`),
status, and duration (`apps/api/src/plugins/observability.js`). The raw URL is never logged —
see [Credentials never reach logs](#credentials-never-reach-logs).
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

### Credentials never reach logs

This app carries credentials in URLs in several places: `?token=` on the SSE streams and the
`/images/` proxy (an `<img>` or `EventSource` cannot send an `Authorization` header), the
token as a path segment on `/review/:token`, and `?token=` on emailed reset links. So no log
line, alert or `error.log` entry ever contains a raw URL. `apps/api/src/lib/log-redaction.js`
(WP-A) enforces this in one place:

| Sink | Protection |
|---|---|
| Fastify request lines (`incoming request` / `request completed`) | `req` serializer logs the route template, falling back to the path with its query removed |
| Slow-request `warn` line | logs `route` (template), not the URL |
| `request.log.error` / any `*.log.*` call | `err` serializer scrubs message and stack; a `logMethod` hook scrubs every string argument, including the message pino derives from an Error |
| Telegram / webhook alert | route from the template; message, text and body scrubbed of JWT-shaped strings, `Bearer` values and `token=` values |
| `error.log` | stack scrubbed the same way |

Every logger `buildApp()` creates gets this, including a caller-supplied logger options
object. pino `redact` is deliberately not used: it matches key paths, while the leak here is
inside a string value. Regression tests: `apps/api/test/log-redaction.test.js` and
`apps/api/test/integration/log-redaction.test.js`. The super-admin org-switch audit row
(`AuditLog.newValue.url`) also stores the path without its query (C10).

**Reverse proxy (Caddy).** `infrastructure/Caddyfile` has no `log` directive, so Caddy writes
no access log. Caddy's *error* log is a different matter. `http.log.error`, written for
example on a 502 while the API restarts, includes `request.uri` with its query string. A
throwaway `caddy:2-alpine` canary test showed the token in that line (count 1 per failed
request).
- **The filter (C11):** a global `log default { format filter { … } }` block now rewrites
  `request>uri` before the line is written. Every query value and the `/review/` path token
  become `REDACTED`, matched case-insensitively and in percent-encoded form too. Only the
  log line changes: the API still receives the full URI.
- **Canary result:** count 4 → 0 across `?token=`, `?ToKeN=`, `?%74oken=` and
  `/review/<token>`, and the proxied request still returned the upstream's 200.
- **Deploy log:** the production deploy job prints only `docker compose ps caddy`, never
  Caddy's logs. Read those on the host.
- **Deploy check:** every deploy (production and staging) fails unless the running Caddy
  passes `caddy validate` and its adapted config contains `REDACTED`. That shows the filter
  is live in the container, not just in the file. See `docs/DEPLOYMENT.md`.

## Super-admin Quality page (`/superadmin-quality`)

A SUPER_ADMIN-only page (linked from the super-admin dashboard) that gathers the platform's
quality signals in one place (WP-Q, [ADR 0005](adr/0005-qa-telemetry-in-production.md)):

- **Latest test run, trend and history.** CI posts each run's scrubbed summary to
  `POST /api/qa/runs`, authenticated with `QA_INGEST_TOKEN`, which answers 404 when unset.
  Runs are stored in the platform-level `QaRun` table, which keeps the newest 500. The page
  shows:
  - the latest run, with a **NOT EXECUTED** warning whenever tests were skipped or cancelled
  - a trend of the last 30 runs
  - a runs table that drills into tiers, files and failures
- **Live CI.** The latest GitHub Actions runs (`GET /api/superadmin/qa/ci-status`), cached
  60 s server-side. The page polls every 15 s while a run is queued or in progress, otherwise
  every 60 s, and pauses while the tab is hidden. It reads with `GH_ACTIONS_DISPATCH_TOKEN`
  when set, otherwise unauthenticated (the repository is public).
- **Run production checks.** Read-only checks, streamed live as NDJSON
  (`POST /api/superadmin/qa/checks`). Each check is capped at 5 s, runs are limited to one
  per 30 s, and every run is audited as `sa_production_checks_run` (statuses only).

  | Check | PASS / WARN / FAIL |
  |---|---|
  | database | reachable and every shipped migration applied / extra unknown migrations / a shipped migration not applied |
  | offsite-backups | newest `db-backups/` object ≤ 26 h old / ≤ 48 h / older, none, or an R2 error (by error name only); SKIPPED on the local storage driver |
  | email | SMTP `verify()` succeeds, without sending / not configured / verify fails (error code only) |
  | config: … | alerting, IP hash pepper, QA ingest token, dispatch token: configured or not (booleans only) |
  | build | commit (`GIT_SHA`), Node version, uptime; WARN without `GIT_SHA` |
  | live connections (SSE) | open SSE connection counts |
  | github dispatch token | valid, with days to expiry / expires in under 14 days / expired or 401; "expiry unknown" when GitHub sends no expiry header; SKIPPED when unset |

  Details never contain a host, bucket name, URL or secret.
- **End-to-end tab.** This shows the latest run that the **E2E** workflow
  (`.github/workflows/e2e.yml`) posted with `source: 'e2e'`:
  - the journeys
  - axe counts and visual state per page and project
  - failures
  - links to the run and its artifacts (report; traces on failure)

  The workflow runs on every PR that touches `apps/api/**` or `e2e/**`, nightly at 21:30 UTC
  (03:00 IST), and on demand.
- **Run full test suite now** (on the End-to-end tab) dispatches that workflow on `main`
  (`POST /api/superadmin/qa/dispatch`).
  - It is only offered when `GH_ACTIONS_DISPATCH_TOKEN` is set: `ci-status` reports
    `dispatchEnabled`.
  - It is limited to one dispatch per 10 minutes, and each one is audited as
    `sa_test_suite_dispatched` (statuses only).
  - It only works once `e2e.yml` is on `main`. Before that, GitHub answers 404/422 and the
    page says so.

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
