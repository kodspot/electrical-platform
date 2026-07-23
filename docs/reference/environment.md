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

## Known discrepancies (as of the 2026-07 audit)

- Some variables have appeared in a deployed `.env` that are **referenced nowhere in
  code** (`PIN_PEPPER`, `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET`)
  and are not in `.env.example` — leftover secret surface to confirm-and-remove. See
  [`../history/production-readiness-audit-2026-07.md`](../history/production-readiness-audit-2026-07.md)
  (finding M3).
- `IP_HASH_PEPPER` is documented in `.env.example` but is **not** listed in the deploy
  workflows' secret env lists (finding M2) — configuring it in production requires adding
  it there too.

## Related

- Canonical values: [`.env.example`](../../.env.example) ·
  Enforcement: [`apps/api/src/config/env.js`](../../apps/api/src/config/env.js)
- [../architecture/auth-and-tenancy.md](../architecture/auth-and-tenancy.md) (secrets),
  [../architecture/resilience.md](../architecture/resilience.md) (alerting, pooling)
- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §6, §17
