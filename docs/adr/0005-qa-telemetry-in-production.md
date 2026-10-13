# 0005. QA telemetry in the production database, a token-authenticated ingest, and outbound GitHub calls

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** Engineering lead / architect, platform owner

## Context

The super-admin needs one place to see whether the platform is healthy and tested, without
reading GitHub Actions logs. That page needs four things:

- **Test-run history.** CI produces a scrubbed run summary on every push and PR (QA-1:
  `apps/api/reports/test-summary.json`).
- **Live CI status.** The latest GitHub Actions workflow runs.
- **Live production checks.** Database and migrations, offsite backups, the email connection,
  configuration, build and live connections.
- **Later: a trigger for the e2e workflow** (Batch 2).

Constraints:
- **One VM, one Postgres, no queue, no second service.** Charter §5 and ADR 0002 rule out
  new infrastructure without strong cause.
- **This repository is public.** Every CI log and artifact is world-readable, so nothing CI
  sends or prints may contain a secret.
- **CI has no user account.** It cannot hold a super-admin JWT, which the API issues per login
  and which expires.
- **Existing auth transports.** Every existing route authenticates a user or a worker through
  `authenticateJWT` / `authenticateWorkerJWT`. A machine caller is new.

## Decision

1. **Store test runs in the production database**, in a new `QaRun` table. It is
   platform-level: no `orgId`, because it describes the platform's code, not any tenant's
   data. Only SUPER_ADMIN can read it, through `/api/superadmin/qa/*` behind the existing
   `authenticateJWT` + `requirePolicy('SUPER_ADMIN')`. The newest 500 rows are kept; older
   rows are deleted in the same transaction as each insert.
2. **Accept runs at `POST /api/qa/runs`, outside `authenticateJWT`**, authenticated by a
   shared secret, `QA_INGEST_TOKEN`, sent as `Authorization: Bearer`.
   - When the token is unset on the server, the endpoint answers 404, so it does not exist.
   - A wrong token gets 401. The comparison is constant-time, using `timingSafeEqual` over
     SHA-256 digests.
   - Bodies are limited to 256 KB and validated with zod.
   - It is rate-limited to 10 per minute, and nothing from the request is echoed back.
   - Stored details are capped, truncated and scrubbed again on the server.
3. **Call the GitHub REST API from the server** (`apps/api/src/lib/github.js`).
   - **Reads:** CI status, cached for 60 s with a 10 s timeout, returning whitelisted fields
     only. It uses an optional fine-grained token, `GH_ACTIONS_DISPATCH_TOKEN` (this
     repository only, Actions read+write, 90-day expiry), and falls back to unauthenticated
     reads, which the public repository allows.
   - **Token check:** the production checks read the token's expiry header and warn 14 days
     ahead.
   - **Dispatch:** the same token will trigger the e2e workflow (Batch 2).
4. **Production checks are read-only and streamed.**
   - **What they touch:** a DB ping plus the migration ledger, R2 `HeadBucket` +
     `ListObjectsV2` (object metadata only), SMTP `verify()` (never sends), configuration
     booleans, build info, SSE counts and one GitHub call.
   - **Output:** every result carries a name, a status and a detail. Details never contain a
     host, bucket name, URL or secret.
   - **Transport:** NDJSON over an authenticated `fetch`. The token goes in the header, never
     in a URL, and there is no EventSource.
   - **Limits:** each check is capped at 5 s, runs are rate-limited to one per 30 s, and each
     run is audited (`sa_production_checks_run`, statuses only).

## Alternatives considered

- **A separate QA service or database.** It would isolate telemetry from tenant data, but it
  is a second deployable, with its own backups and secrets, on a one-VM platform (ADR
  0002). The table is small, capped and super-admin-only, so it doesn't justify one.
- **Read results from GitHub only (artifacts and the run API).** No ingest needed, but it
  means downloading and unzipping artifacts per page view. It's slow, rate-limited, and loses
  history when artifacts expire (90 days).
- **A super-admin JWT stored as a CI secret.** It would reuse the existing auth stack, but
  user JWTs expire and are tied to a person. A long-lived human credential in CI is a bigger
  blast radius than a single-purpose token that can only append test runs.
- **GitHub webhooks into the app.** Push instead of poll, but it needs a public webhook
  endpoint with signature verification, plus more secret management. Polling a cached,
  rate-limit-friendly endpoint is enough at this scale.
- **Server-Sent Events for the checks.** EventSource cannot send an `Authorization` header,
  which would force the token into the URL, the exact leak WP-A closed.

## Consequences

- **A second authentication transport exists** for one route (Charter §9 asks for an ADR;
  this is it). It is narrow: a shared secret that can only append a test-run row. Rotate
  `QA_INGEST_TOKEN` by updating the GitHub secret and redeploying; the next deploy rewrites the
  server `.env`.
- **Production now makes outbound calls to `api.github.com`.** A GitHub outage degrades only
  the Quality page: CI status shows "unavailable", and the token check fails with a short
  reason.
- **The fine-grained token expires every 90 days.** The production checks warn 14 days
  ahead. Without a valid token, CI status still works unauthenticated, but dispatch does not.
- **`QaRun` joins the short "not tenant-scoped" list** in
  [`architecture/auth-and-tenancy.md`](../architecture/auth-and-tenancy.md).
- **Reversing this** means dropping the `QaRun` table (a later contract migration), removing
  `qa.js` / `superadmin-qa.js` and `lib/github.js`, and deleting the CI ingest step. No other
  feature depends on them.

## Related

- [`../MONITORING.md`](../MONITORING.md): the Quality page.
- [`../reference/environment.md`](../reference/environment.md): `QA_INGEST_TOKEN`,
  `GH_ACTIONS_DISPATCH_TOKEN`, `QA_GITHUB_REPO`, and how they reach production.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md): the CI ingest step.
- ADR [0002](0002-modular-monolith.md) (one deployable), ADR
  [0003](0003-shared-database-multi-tenancy.md) (tenant scoping, which this table is
  deliberately outside).
