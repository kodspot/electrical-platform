# Environment Variables

**Canonical value/format source: [`.env.example`](../../.env.example).** Copy it to `.env`
and fill in real values. This document is the *semantics* layer that a flat template can't
carry: which variables are required, how each is validated at boot, what it controls, and
who owns it. **Enforcement source of truth: [`apps/api/src/config/env.js`](../../apps/api/src/config/env.js)**,
which runs at startup before anything else and fails fast on a missing or weak value.

Do not restate values here — if a value or default changes, it changes in `.env.example`
and `config/env.js`; this table describes behavior, not values.

## Required (boot fails if missing)

`config/env.js`'s `REQUIRED_ENV` list — the process exits at startup if any is unset:

| Variable | Controls | Extra validation at boot |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection | Pool params (`connection_limit=10&pool_timeout=10`) appended if absent (`lib/prisma.js`) |
| `JWT_SECRET` | Signs/verifies all JWTs | **≥ 32 chars** (`MIN_SECRET_LENGTH`) — a short secret is forgeable |
| `COOKIE_SECRET` | Signs cookies | **≥ 32 chars** |
| `ADMIN_KEY` | SuperAdmin bootstrap key | **≥ 16 chars** |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 (images + offsite backups) | present-check only — **required only when `STORAGE_DRIVER` is `r2`/unset** (see Image storage driver below); not required with `STORAGE_DRIVER=local` |

## Required-format (validated in every environment)

| Variable | Controls | Validation |
|---|---|---|
| `DATA_ENCRYPTION_KEY` | AES-256-GCM key for PII at rest (`lib/crypto.js`) | Must be **exactly 64 hex chars**; enforced unconditionally (never gated on `NODE_ENV`) — without it, PII would store in plaintext |

## Environment mode

| Variable | Controls | Notes |
|---|---|---|
| `NODE_ENV` | Query-log verbosity (`lib/prisma.js`), CORS restriction (`plugins/security.js`), HSTS (`plugins/security.js`) | Must be exactly `production` in real deploys. A value outside `production`/`development`/`test` triggers a startup **warning** (catches typos silently disabling prod-safe defaults). Unset = local-dev convention. |
| `APP_URL`, `COOKIE_DOMAIN`, `PORT` | Public URL, cookie scope, listen port | `APP_URL` defaults to `http://localhost:$PORT` |
| `TZ` | The server's time zone. A calendar day in every date filter (`from`/`to` = `YYYY-MM-DD`) is a day in this zone: `lib/dates.js` `dayRange` (BUG-0055) | Set to `Asia/Kolkata` by `docker-compose.yml`, the zone the users are in. One zone for every organization: there is no per-org time zone (PAR-10/07) |

## Image storage driver

| Variable | Controls | Notes |
|---|---|---|
| `STORAGE_DRIVER` | Where uploaded images are stored (`lib/r2.js`) | `r2` (default) → Cloudflare R2, **requires the R2 credentials below**. `local` → local filesystem (`data/uploads/`), **needs no cloud credentials** and drops the R2 vars from the required-secret set at boot (`config/env.js`). Production leaves this unset. Development uses `local` (see `.env.dev.example`). |
| `LOCAL_STORAGE_DIR` | Override the local driver's storage root | Optional; defaults to the app-root `data/uploads/` (git-ignored). Only relevant when `STORAGE_DRIVER=local`. |

## Optional — with safe fallbacks

Unset is safe; behavior degrades gracefully. Recommended in production where noted.

| Variable(s) | Feature | If unset |
|---|---|---|
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | Falls back to `APP_URL`; restriction still applies in production |
| `IP_HASH_PEPPER` | Peppers the public-complaint abuse-detection IP hash (`[WP11]`) | Unpeppered hash (safe fallback); **production startup warning** |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | Global rate limit | Defaults (1000 / 60000ms) |
| `ADMIN_RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_WINDOW` | Stricter admin-endpoint limit | Defaults |
| `SES_SMTP_HOST` / `SES_SMTP_USER` / `SES_SMTP_PASS` / `SES_FROM_EMAIL` | Email delivery (`lib/email.js`) | Email silently no-ops (password reset, notifications won't send) |
| `ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` / `ALERT_WEBHOOK_URL` | 5xx error alerting (`errors.js`) | Alerting no-ops — errors only reach `data/logs/error.log` |
| `GLOBAL_AI_API_KEY` / `GLOBAL_AI_PROVIDER` / `GLOBAL_AI_MODEL` | Org-level default AI key fallback (`lib/ai-provider.js`) | Orgs use only their own configured key |
| `GIT_SHA` | The deployed commit, shown in `/health/info` (`build.commit`) and the startup log (`lib/diagnostics.js`) | `commit: null` |
| `QA_INGEST_TOKEN` | Bearer secret for `POST /api/qa/runs`, the CI → super-admin Quality page ingest | The ingest endpoint answers `404` |
| `QA_GITHUB_REPO` | `owner/name` of the repository the Quality page reads CI status from (`lib/github.js`) | `kodspot/electrical-platform` |
| `GH_ACTIONS_DISPATCH_TOKEN` | Fine-grained GitHub token (this repo only, Actions read+write): Quality page CI status and the "run full test suite" dispatch | CI status uses unauthenticated reads of the public repo; dispatch is unavailable |

**How these reach production.** `IP_HASH_PEPPER`, `QA_INGEST_TOKEN` and
`GH_ACTIONS_DISPATCH_TOKEN` are GitHub Actions repository secrets, and `GIT_SHA` is
`github.sha`. All four reach the server **only** through the deploy job: it puts them in the
SSH step's `env`/`envs:` and writes them into the server's `.env`, which
`docker-compose.yml` passes to the `api` container. Never set them by hand on the server; the
next deploy rewrites `.env`. `QA_INGEST_URL` is a **CI-only** secret (where the test job posts
its summary); the app never reads it. Staging uses `STAGING_`-prefixed equivalents.

**`PROD_SMOKE_ORG_SLUG`** is a **CI-only repository variable** (Settings › Secrets and variables ›
Actions › *Variables*, not a secret: the slug is public in that organization's URLs). It names
the organization whose public and login pages the production smoke checks
(`.github/workflows/prod-smoke.yml`, [ADR 0009](../adr/0009-post-deploy-production-smoke.md)).
The app never reads it. Unset, the smoke fails with a message naming it.

## Test-only (read by the test runner, never by the app)

Read by `apps/api/scripts/run-tests.js`, `apps/api/test/setup/safety.js` and
`apps/api/test/helpers/db.js` (QA-1). Not in `.env.example`: they are never set for the app
and never belong in a `.env` file.

| Variable | Controls | Notes |
|---|---|---|
| `QA_STRICT` | `1` makes `npm test` exit non-zero when any test was skipped, todo or cancelled (not executed). | Outside CI, skips otherwise only produce a `NOT EXECUTED: N tests — this is not a pass` warning. |
| `CI` | `true` (set automatically by GitHub Actions) makes skipped/todo/cancelled tests fail the run, makes an unreachable database fail DB-backed tests instead of skipping them, and requires an explicit `DATABASE_URL` in the environment (a `.env` file is ignored). | Not a new variable; this documents what the test runner does with it. |

The test guard also constrains `DATABASE_URL` and `NODE_ENV` while tests run: a loopback
host, a database name ending in `_ci`/`_test`/`_e2e`, and `NODE_ENV=test`. It also blanks
`SES_*`, `ALERT_*` and `GLOBAL_AI_*` and replaces `R2_*` with placeholders. See
[`apps/api/test/README.md`](../../apps/api/test/README.md).

## Known discrepancies (as of the 2026-07 audit)

- Some variables have appeared in a deployed `.env` that are **referenced nowhere in
  code** (`PIN_PEPPER`, `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET`)
  and are not in `.env.example` — leftover secret surface to confirm-and-remove. See
  [`../history/production-readiness-audit-2026-07.md`](../history/production-readiness-audit-2026-07.md)
  (finding M3).
- ~~`IP_HASH_PEPPER` is not listed in the deploy workflows' secret env lists (finding M2)~~
  **Resolved 2026-10-13 (WP-OPS):** both deploy workflows now pass it to the server.

## Related

- Canonical values: [`.env.example`](../../.env.example) ·
  Enforcement: [`apps/api/src/config/env.js`](../../apps/api/src/config/env.js)
- [../architecture/auth-and-tenancy.md](../architecture/auth-and-tenancy.md) (secrets),
  [../architecture/resilience.md](../architecture/resilience.md) (alerting, pooling)
- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §6, §17
