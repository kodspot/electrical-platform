# Production Readiness Audit — 2026-07 (post-WP17)

> **Status: frozen snapshot.** This is a dated, point-in-time record, not a living
> document. Do not edit it to reflect later fixes — when the open items below are
> resolved, that is recorded in `CHANGELOG.md` and (for anything architecturally
> significant) a new ADR, and a *future* audit becomes a new file alongside this one.
> Treat every "open" item here as "open **as of 2026-07**" and verify current state
> before acting.

## Context

This codebase was hardened through an audit-driven **Work Package program (WP1–WP17)**
following an initial production-readiness audit. The `[WPn]` tags throughout the code
comments and the Engineering Charter refer to that program. The canonical, in-repo
records of what each Work Package changed and why are:

- **`docs/ENGINEERING_CHARTER.md`** — its dated **Amendment Log** is the authoritative
  per-decision record (this document does not duplicate it).
- **`CHANGELOG.md`** — the chronological "what shipped when."

This audit was performed after WP17, treating the repository as if it were about to be
deployed to production. It is preserved here because its **open findings are actionable
and were not otherwise captured in the repository** — the trapped knowledge worth keeping.

## Verdict at time of audit

**NOT READY FOR PRODUCTION**, pending the two CRITICAL items below. Everything else —
authentication, authorization, tenant isolation, business logic, testing (256 tests
passing, 0 failures), lint (0 errors), documentation, Docker hardening, CI/CD, and
automated backups — was assessed as production-grade. Indicative readiness score at the
time: **62/100**, driven down almost entirely by C1 and C2.

## Open findings (as of 2026-07)

### Critical

**C1 — Known-vulnerable production dependencies, with no CI gate.**
`npm audit --omit=dev` reported **1 critical + 10 high + 1 moderate** vulnerabilities in
the exact dependency set shipped in the Docker image, including `fastify` itself (DoS),
its JSON-serialization stack (`fast-json-stringify` / `fast-uri`), `nodemailer` (SMTP
command injection — and it is actively used for password/PIN-reset and admin emails via
`apps/api/src/lib/email.js`), `fast-xml-parser` (critical, via the AWS SDK used for R2),
and `tar` / `minimatch` / `brace-expansion`. No workflow in `.github/workflows/` runs
`npm audit`, so this class of issue can reach `main` with no automated warning.
*Recommendation:* `npm audit fix` for the non-breaking set; plan and test the breaking
`nodemailer`/`fastify` major upgrades; add a blocking `npm audit --omit=dev
--audit-level=high` step to both workflows.

**C2 — Offsite disaster-recovery backup (Cloudflare R2) self-documented as
non-functional.** `docs/DISASTER_RECOVERY.md` records that the last restore drill found
the R2 offsite step failing with `403 Access Denied` on *every* operation — the same
credentials and request shape the application's own image-upload path
(`apps/api/src/lib/r2.js`) uses. If this also affects the real production credentials, it
means both (a) no offsite backup exists, and (b) live ticket/inspection photo uploads
fail. The available `.env` has all four `R2_*` variables present and plausibly formatted,
but presence is not validity and this checkout cannot confirm the deployed secrets.
*Recommendation:* run `node apps/api/scripts/backup-r2.js list` against the real
production credentials before go-live; fix the Cloudflare token scope if it fails; re-run
the restore drill and update the drill record.

### High

- **H1 — No dependency-vulnerability scanning gate in CI.** The `prestart` audit in
  `apps/api/package.json` is non-blocking *and* never runs, because the Dockerfile `CMD`
  invokes `node index.js` directly, bypassing npm lifecycle hooks. (Root cause behind
  C1's silent reachability.)
- **H2 — Error alerting unconfigured.** `apps/api/src/errors.js`'s Telegram/webhook
  alerting is fully implemented but no-ops without `ALERT_TELEGRAM_*` / `ALERT_WEBHOOK_URL`
  set — none were present in the available environment. A 5xx spike would notify no one.

### Medium

- **M1 — CSP still allows `'unsafe-inline'`** for scripts and styles
  (`apps/api/src/plugins/security.js`) — a known, Charter-tracked weakening of the XSS
  defense-in-depth layer.
- **M2 — `IP_HASH_PEPPER` unconfigured** and absent from both deploy workflows' secret
  lists — the public-complaint abuse-detection hash runs unpeppered (safe fallback, but
  the intended hardening is off).
- **M3 — Undocumented, unused env vars** in the available `.env` (`PIN_PEPPER`,
  `RAZORPAY_KEY_ID`/`_SECRET`/`_WEBHOOK_SECRET`) — referenced nowhere in code; leftover
  secret surface to confirm-and-remove.
- **M4 — Deploys incur a brief full-stack outage window** (`docker compose down` before
  rebuild) — an accepted single-VM trade-off, not a bug, but should be a conscious one.
- **M5 — Backup RPO up to 24h** (daily cron) — already self-documented in
  `docs/DISASTER_RECOVERY.md`; fix is more frequent runs, not code.

### Low

- **L1 — Several migrations share identical timestamp prefixes** — cosmetic; Prisma
  applies by unique directory name, and the ordering happens to be correct.
- **L2 — Restore drill used a 24 KB dataset** — the 1-second RTO is not representative of
  production scale (already noted in the DR doc).
- **L3 — JWT verification passes no explicit `algorithms` allow-list** — not currently
  exploitable (single symmetric secret, HS256 only); worth adding as defense-in-depth.

## What was strong (for balance)

Authentication/authorization/tenancy (every request re-checks `isActive` and org status
against the DB; `tokenInvalidBefore` session invalidation; `orgId`-scoped ownership checks
before every mutation), Docker hardening (non-root, `no-new-privileges`, DB bound to
localhost, API exposing no host ports), CI (full DB-backed suite gates every deploy), and
documentation depth were all assessed as genuinely production-grade.
