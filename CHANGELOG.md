# Changelog

All notable changes to this project are recorded here. This file was established by
`[WP16]` (Documentation & Release Process Hygiene) as an ongoing convention — see
`docs/ENGINEERING_CHARTER.md` §18 for how this differs from user-facing Release Notes:
**this file** gets an entry for every merged change, internal refactors and tooling
changes included; **Release Notes** are reserved for changes a guest, electrician,
supervisor, admin, or superadmin would actually notice, written in their language.

Entries are grouped by date and tagged with the Engineering Execution Plan Work Package
(`[WPn]`) that produced them, mirroring `docs/ENGINEERING_CHARTER.md`'s own Amendment Log
— that document explains *why* each change was made and the durable rule it established;
this file is the terser, chronological "what changed and when."

This changelog currently starts at `[WP7]` — the earliest work in the current
production-hardening pass this project has a verified, dated record for (via the Charter's
own Amendment Log). `apps/api/package.json` currently declares version `1.0.0`; nothing
has been git-tagged yet, so everything below is grouped under **Unreleased**.

## Unreleased

Complete and merged into the working tree as of this writing, pending its next deploy —
see `docs/DEPLOYMENT.md` for how a change reaches production.

### 2026-10-13

- **User-visible (Release Notes):**
  - **Every electrician now needs an Employee ID.** It is required when adding an
    electrician (admin and super-admin screens), and it can't be blanked out later,
    because it's what electricians sign in with alongside their PIN. Electricians added
    earlier without one are unchanged, but an Employee ID must be entered the next time
    one of them is edited.
  - **Supervisors get one notification per public complaint.** A supervisor responsible
    for the location no longer receives two.
  - **Tickets go to the nearest responsible supervisor.** When several supervisors cover
    a location, a new complaint or ticket is now consistently assigned to the one closest
    to it.
- **`[WP-H]` Approved fixes F2, F3, F4 and F8.**
  - **F2:** stable assignment order in `services/assignment-resolver.js` (direct, then
    nearest ancestor, then `isPrimary` for workers, then `createdAt`, then `id`).
  - **F3:** `notifySupervisors()` gains an optional `{ excludeUserIds }` argument,
    backward compatible; the public-complaint broadcast skips the supervisors who were
    already notified directly.
  - **F4:** failed notification steps on ticket creation (`public.js`, `tickets.js`) log
    one `warn` line `{ ticketId, step, err }`; they stay fire-and-forget.
  - **F8:** `employeeId` is required on worker create and can't be cleared via PATCH, on
    both the admin and super-admin routes. This is an API contract change (Charter §9):
    those requests now return 400.
  - **Tests and docs:** `test/integration/approved-fixes.test.js`,
    `test/integration/notification-step-warn.test.js`; bug registry BUG-0004 (F3) and
    BUG-0005 (F8); `COVERAGE_MATRIX.md` updated.
- **`[WP-A]` Credentials kept out of logs and alerts.** The app carries credentials in URLs
  (`?token=` on the SSE streams and `/images/`, `/review/:token`, reset links). Logs and
  alerts now describe a request by its route template, falling back to the path without its
  query; they never use the raw URL.
  - New `apps/api/src/lib/log-redaction.js`: `stripQuery`, `describeTarget`,
    `scrubJwtShapes`, `buildLoggerOptions`.
  - Every logger `buildApp()` creates gets `req`/`url`/`err` serializers and a `logMethod`
    hook (no pino `redact`), merged into a caller-supplied logger too.
  - The slow-request log, Telegram/webhook alerts and `error.log` are scrubbed.
  - Regression tests use a canary JWT across every token URL shape, the slow path, the 5xx
    path and a caller-supplied logger, plus a control run showing that an unpatched logger
    leaks.
  - Also: `scripts/run-tests.js` now prints "test report could not be produced" once,
    instead of twice.

### 2026-10-12

- **`[QA-1]` Test-target safety, skip gate, run report, coverage inventory** —
  - **Safety guard.** `npm test` (and `bug:test`, `test:phase1`) now runs through
    `apps/api/scripts/run-tests.js`, which loads `test/setup/safety.js` into every test
    process. The guard **fails closed**: tests refuse to start unless `NODE_ENV=test` and
    `DATABASE_URL` points at a loopback host and a database named `*_ci`/`*_test`/`*_e2e`
    with no connection-redirecting query parameters. Under `CI=true` the URL must also be
    explicit in the environment. It blanks outbound SES/alert/AI credentials and
    placeholders R2 before dotenv can inject the real `.env` values.
  - **Skip gate.** `test/helpers/db.js#isDatabaseAvailable()` re-checks the same rules
    against the URL Prisma actually captured. Under `CI=true` an unreachable database now
    **fails** DB-backed tests instead of silently skipping them, and the run fails on any
    skipped/todo/cancelled test (also opt-in locally with `QA_STRICT=1`).
  - **Run report.** Each run writes a scrubbed `reports/junit.xml` and a readable
    `reports/test-summary.md`: counts, baseline vs current, per-tier and per-file tables,
    failures with an ENVIRONMENT/UNCLASSIFIED classification, and a
    `NOT EXECUTED: N — this is not a pass` line. These use Node's built-in spec/JUnit
    reporters plus a small reporter on Node's own API (`scripts/report-events.js`) for the
    file paths and hook errors that Node 20's JUnit output drops.
  - **Inventory.** New `docs/testing/COVERAGE_MATRIX.md`, with characterisation findings
    F1–F11 (open questions for the owner, no code changed).
  - **Docs and tests.** `apps/api/test/README.md` and `apps/api/README.md` are corrected,
    including the stale demo electrician PIN (`123456`, not `1234`). New tests: safety
    guard, DB gate, report, preload canary.
  - **Scope.** Verified on Node 24.11.1 and Node 20.20.2 against a disposable Postgres. No
    production code, dependency, workflow or compose change.

### 2026-07-22

- **Production observability & operational diagnostics (platform milestone M6)** — Added a
  `GET /health/info` operational-diagnostics endpoint (version/build/runtime metadata,
  dependency health, and secret-free configuration booleans), a universal `x-request-id`
  response header for request correlation (reusing the existing request id and pino
  request-scoped logger — error responses already carried `requestId`), slow-request
  logging at `warn` (default 2000ms, `SLOW_REQUEST_MS`; SSE streams excluded), and a
  one-line startup runtime-configuration summary. All observability draws from one source of
  truth (`apps/api/src/lib/diagnostics.js`), shared by the endpoint and the startup log; the
  hooks live in `apps/api/src/plugins/observability.js`. No business functionality changed;
  no second logging or monitoring system introduced. Existing health endpoints unchanged.
- **CI/CD validation platform (platform milestone M5)** — Added one comprehensive CI gate,
  `npm run ci` (lint + the full test suite — which already includes the scenario platform
  and bug regression library — plus new repository-structure, package-integrity,
  environment-documentation, migration-safety, and generated-doc-drift checks in
  `apps/api/scripts/ci-validate.js`), and `npm run release:check` for deployment readiness.
  The production CI workflow's **test gate** now runs `npm run ci` (the deploy job's SSH/
  docker logic is unchanged), so CI and local validation can never diverge, and deployment
  stays an intentional, gated action. **Fixed a latent CI defect**: the workflow's
  placeholder `JWT_SECRET` was 30 chars, below the app's own 32-char boot minimum, so the
  gate would have failed at app startup. **Fixed a cross-platform defect**: `npx`/`npm`
  spawned from the M2/M3 platform scripts (`doctor`/`setup`/`reset`) failed on Windows
  (`ENOENT`/`EINVAL`); they now spawn with `shell: true` via a shared `_platform` helper.
- **Bug reproduction platform & regression library (platform milestone M4)** — Built a
  production-incident framework on top of the M3 scenario system (`apps/api/scenarios/bugs/`):
  every fixed defect is a reproducible scenario with full metadata (id, severity, status,
  module, root cause, dates, scenario dependencies, regression mapping) and a `validate()`
  that asserts the fixed behavior via the real app. Seeded with three real fixed defects
  (BUG-0001 ticket-state guard, BUG-0002 worker-delete parity, BUG-0003 public-complaint
  spam enforcement). Added commands `npm run bug:list` / `bug:run` / `bug:validate` /
  `bug:test` (reusing the M3 engine and the production-safety guard — no duplicated
  execution logic), a generated catalog (`docs/reference/bug-registry.generated.md` via
  `npm run docs:bugs`), and a driving regression test (`test/integration/bug-regressions.test.js`)
  so any reverted fix fails the suite. No production runtime changed.
- **Scenario system, demo dataset & seed platform (platform milestone M3)** — Introduced a
  reusable business-scenario system (`apps/api/scenarios/`) that is the single source of
  truth for local development, the demo dataset, tests, and (later) bug reproduction. The
  test factories were extracted verbatim to `apps/api/scenarios/factories.js` and
  re-exported by `test/helpers/db.js`, so tests and seeding share one factory system (no
  duplication). Added an 11-scenario catalog (fresh-installation, demo-organization, and
  the ticket/electrical/attendance/notification/AI/supervisor/worker/admin/reporting
  workflows), a dependency-resolving engine, and the commands `npm run seed` / `demo` /
  `scenario` (all local-only, production-guarded) plus completed `npm run reset` (db reset
  + seed). Demo data is deterministic (verified: two seeds produce an identical
  fingerprint). New regression tests: `test/integration/scenarios.test.js`.
- **Developer command interface & environment (platform milestone M2)** — Added a
  root-level developer command surface (`npm run setup` / `dev` / `doctor` / `verify` /
  `reset` / `clean`) per the Developer Platform Specification §2, plus `docker-compose.dev.yml`
  (Postgres-only, isolated volume) for a fast host-run inner loop. `reset`/`clean` carry a
  production-safety guard (`apps/api/scripts/_platform.js`) that refuses to run against any
  non-local database. `verify` composes lint + tests + a route-index drift check. Fixed a
  pre-existing test-fallback bug (`app-smoke.test.js`'s 30-char `JWT_SECRET` fallback
  predated WP13's 32-char minimum, breaking `npm test` from a fresh shell). Documentation
  only affects developer workflow; no production runtime behavior changed.
- **Local storage driver (platform milestone M1)** — Added a `STORAGE_DRIVER` (`r2` default
  | `local`) abstraction to `apps/api/src/lib/r2.js`. `local` stores uploaded images on the
  filesystem (`data/uploads/`, git-ignored) and serves them through the existing `/images/`
  proxy, so the app boots and handles image uploads with **no cloud credentials** —
  `config/env.js` drops the R2 vars from the required set when `STORAGE_DRIVER=local`. Added
  `.env.dev.example` (copy-once local config) and a README local-run guide. Production is
  unchanged: with `STORAGE_DRIVER` unset/`r2`, behavior is byte-for-byte identical.
  Regression tests: `test/lib-storage.test.js` (local driver upload/serve/delete/404/traversal)
  and two new cases in `test/config-env-validation.test.js`.

### 2026-07-21

- **Engineering knowledge base** — Built out the documentation system beyond `[WP16]`'s
  foundation into a complete, navigable knowledge base: a documentation index
  (`docs/README.md`), an AI-assistant entry point (`CLAUDE.md`), a frozen
  production-readiness snapshot (`docs/history/`), the architecture explanation set
  (`docs/architecture/` — overview, auth & tenancy, data model, module system, resilience,
  frontend), generated/semantic reference docs (`docs/reference/routes.generated.md` via
  `apps/api/scripts/gen-route-index.js` / `npm run docs:routes`, and
  `docs/reference/environment.md`), operations docs (`docs/MONITORING.md`,
  `docs/RUNBOOKS.md`), and an ADR framework (`docs/adr/` index + template + foundational
  ADRs 0002–0004). Integrated the doc system into the Charter's §22 trigger table and
  removed the empty `docs/replication-pack/` placeholder. Documentation-only; no
  application behavior changed.
- **`[WP16]` Documentation & Release Process Hygiene** — Established this CHANGELOG and
  the root `README.md`. Corrected a garbled comment in `apps/api/index.js` describing the
  image-cleanup scheduler's timer-capture fix.
- **`[WP15]` Notification Channel Unification** — Notification+email pairs that previously
  fired as two independent calls (`tickets.js`, `public.js`) now go through one shared
  `notify()` interface (`services/notification-service.js`), so a future channel addition
  (SMS, push) is one change, not one change per call site.
- **`[WP10]` Automation & Alerting Reliability** — Consolidated three duplicated
  AI-provider-calling implementations into one shared module (`lib/ai-provider.js`),
  closing a gap where scheduled AI insight generation ran with no circuit-breaker
  protection. Missed-inspection alerting now reads each org's configured shift windows
  instead of a hardcoded deadline table.
- **`[WP11]` Public Complaint Abuse Prevention** — The spam risk score computed on public
  complaints is now enforced (`429` at its existing top tier) instead of only recorded.
  The abuse-detection IP hash is now peppered (`IP_HASH_PEPPER`), with a safe unpeppered
  fallback when unset.
- **`[WP14]` Account Recovery & Authentication Session UX** — Added self-service password
  reset (`User`) and PIN reset (`Worker`), with single-use, time-limited,
  anti-enumeration-protected tokens. Worker PIN changes no longer force an unnecessary
  re-login.

### 2026-07-20

- **`[WP13]`** Production-readiness pass — `JWT_SECRET`/`COOKIE_SECRET`/`ADMIN_KEY` are now
  validated for minimum strength at boot, not just presence. A startup warning now catches
  a typo'd `NODE_ENV`.
- **`[WP12]` Operational Resilience, Error Handling & Recovery** — The database and
  AI-provider circuit breakers (`dbBreaker`, `aiBreaker`) are now actually wired into all
  real traffic (a Prisma Client Extension covers every database call; both live AI
  endpoints are wrapped) instead of only being displayed on `/health`. Added an
  `uncaughtException` process handler alongside the existing `unhandledRejection` one.

### 2026-07-19

- **`[WP11]`** (performance) — Location-hierarchy walks (`services/assignment-resolver.js`)
  rewritten as single-round-trip recursive CTEs instead of one query per hierarchy level.
  One alert-notification path batched into a single `createMany` instead of one insert per
  recipient.
- **`[WP10]`** (state-transition consistency — see `docs/ENGINEERING_CHARTER.md` §8.2;
  distinct from the same-numbered `[WP10] Automation & Alerting Reliability` above) —
  Generic admin PATCH routes (`tickets.js`, `assets.js`) could previously set fields into
  states their own dedicated action routes would never produce; both gaps closed.
- **`[WP9]`** — Multi-step writes across the asset/failure/event workflows are now wrapped
  in `$transaction`; eliminated a create-then-update double-write in ticket
  auto-assignment.
- **`[WP8]`** — SuperAdmin `X-Org-Id` cross-tenant reads are now fully audited (previously
  only non-`GET` requests were logged). Fixed two routes mislabeling a SuperAdmin's write
  as a supervisor's in the org's own audit trail.
- **`[WP7]`** — Closed Audit finding `[H1]`: an exhaustive, file-by-file tenant-scoping
  sweep of every route, plus new regression tests
  (`test/integration/tenant-isolation*.test.js`). No exploitable cross-tenant leak was
  found; several defense-in-depth gaps were hardened anyway.
