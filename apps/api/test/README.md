# Test suite structure

Run with `npm test` (all files) from `apps/api/`. It uses Node's built-in `node:test` — no external test framework dependency. What the suite does and does not cover, workflow by workflow, is inventoried in [`docs/testing/COVERAGE_MATRIX.md`](../../../docs/testing/COVERAGE_MATRIX.md).

## How to run

```
npm test                                        # whole suite
node scripts/run-tests.js test/lib-crypto.test.js   # one or more files (or: npm test -- <files>)
npm run bug:test                                # bug regression library only
npm run ci                                      # lint + tests + repository checks (what CI runs)
```

`npm test` runs `scripts/run-tests.js`, which:

1. **Runs every test process with the safety guard** (`test/setup/safety.js`, loaded with `node --require`). It forces `NODE_ENV=test`. Always use `npm test` / `scripts/run-tests.js`: a bare `node --test` skips the guard, and the canary test (`test/preload-canary.test.js`) fails on purpose.
2. **Prints the spec reporter** to the console, and writes `reports/junit.xml` and `reports/test-summary.md` (git-ignored). With `GITHUB_STEP_SUMMARY` set, the summary is also appended to the CI job summary. Raw reporter output goes to the OS temp directory and is deleted once scrubbed: JWT-shaped strings, bearer tokens, Authorization headers, URL credentials, `key=value` secrets and long hex/base64 runs are redacted before anything is written.
3. **Decides the exit code.** It is non-zero when a test failed, when the test process died, or when the report could not be produced. With `CI=true` or `QA_STRICT=1`, any skipped, todo or cancelled test also makes it non-zero. It is also non-zero when a suite fails outside its tests. That covers a `describe()` body that throws while its tests are being collected (BUG-0029), and a suite hook such as an `after()` cleanup that throws (BUG-0036). Node (24) reports such a suite as failed but exits 0 and counts no failure. The wrapper reads these from the events stream; the JUnit XML records only the first kind.

### What you need locally

DB-backed tests need a **disposable, loopback** Postgres whose database name ends in `_ci`, `_test` or `_e2e`, passed explicitly:

```
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5433/electrical_test npm test   # 5433 = docker-compose.dev.yml
```

Run `npx prisma migrate deploy` against it first. The app also needs its usual required variables (`JWT_SECRET`, `COOKIE_SECRET`, `ADMIN_KEY`, `DATA_ENCRYPTION_KEY`); the guard always replaces `R2_*` with placeholders. The `app-smoke` tier boots the whole app, so it needs these even without a reachable database.

## The safety guard (fail closed)

`test/setup/safety.js` runs in every test process before the app's dotenv call, and refuses to run (exit 1, before any test) unless:

- `NODE_ENV` is exactly `test`.
- `DATABASE_URL` — the ambient value, or else the one the repo-root `.env` would inject — points at **127.0.0.1, localhost or ::1**, carries **no** `host`/`hostaddr`/`port`/`dbname`/`service` query parameter, and names a database matching `^[A-Za-z0-9_]+$` that ends in `_ci`, `_test` or `_e2e`. A `DATABASE_URL` pointing at the compose host `db` (or any other host) is **refused by design**, and so is a non-test database name such as `electrical`.
- With `CI=true`, `DATABASE_URL` is given explicitly in the environment. A `.env` file is never used in CI.

If no `DATABASE_URL` exists at all outside CI, the guard allows it, because `src/config/env.js` then refuses to boot the app, so nothing can reach a database.

The guard also blanks outbound credentials so no test can send real email, alerts or AI calls: `SES_*`, `ALERT_TELEGRAM_*`, `ALERT_WEBHOOK_URL` and `GLOBAL_AI_*` become `''`, and `R2_*` become `test-placeholder`. dotenv never overrides a key that is already set, even to `''`, so the real `.env` values cannot come back. Refusal messages name the rule that failed and never print a URL, host, name or credential.

`test/helpers/db.js#isDatabaseAvailable()` re-checks the same rules right before a test touches the database. It judges both the current `DATABASE_URL` and the value `src/lib/prisma.js` captured when it loaded: Prisma reads the URL once, at first load, and never again.

## Skipped is not passed

DB-backed tests call `isDatabaseAvailable()` in a `before()` hook:

- **Outside CI**, an unreachable database makes them `t.skip()`. The run still exits 0, but the console and summary say **`NOT EXECUTED: N tests — this is not a pass`**. Set `QA_STRICT=1` to make that a non-zero exit.
- **With `CI=true`**, an unreachable database **throws** instead. The files' tests are reported as *cancelled* (that is how `node:test` reports tests whose `before()` hook failed), the summary shows the cause ("CI=true: database unreachable"), and the run fails.

## Tiers

The counts per tier for the current suite are in `docs/testing/COVERAGE_MATRIX.md`; every run's summary recomputes them.

**1. Unit tests** (`test/*.test.js`) — pure functions and in-process logic with no database: the permission-policy contract, tenant-context propagation, route-guard standardization, `lib/crypto.js`, `lib/security.js`, `lib/r2.js`'s local storage driver, `services/ticket-status.js`, `services/module-policy.js`, `config/env.js` boot validation (child processes), and the QA-1 safety guard, DB gate, report and canary tests.

**2. App smoke tests** (`test/integration/app-smoke.test.js`, `observability.test.js`) — real HTTP-level requests via `fastify.inject()` against the fully-wired app, scoped to paths that answer *before* any database call: missing, forged or garbage auth tokens, `/health` degradation, `/health/live`, `/health/info`, early input validation, and `requestId`/`x-request-id` correlation. They need the app's required environment variables, but no reachable database.

**3. Database-backed integration tests** (every other file in `test/integration/` except the tiers below) — real HTTP requests against real seeded data: tenant isolation for every route file (`tenant-isolation*.test.js`), the ticket lifecycle, public complaints and their abuse prevention, account recovery, business-rule enforcement, transaction safety, notification fan-out, superadmin impersonation auditing, scheduler locks, and location-hierarchy queries.

**3b. Environment-aware tests** (`test/integration/health-ready.test.js`) — these check the real database state via `isDatabaseAvailable()` and assert whichever outcome it implies (200/connected vs 503/disconnected). Under `CI=true` an unreachable database fails them too, because CI must have one.

**4. Scenario tests** (`test/integration/scenarios.test.js`) — the seed/scenario engine: determinism, idempotence and standalone application.

**5. Bug regression tests** (`test/integration/bug-regressions.test.js`) — one test per registered bug in `scenarios/bugs/`.

Files under `test/helpers/` and `test/setup/` are executed by `node --test` discovery too; each shows up as one passing entry with no tests ("support" in the summary).

## Fixtures

`test/helpers/db.js` re-exports the shared factories (`scenarios/factories.js`). They create throwaway Organizations (and, through cascading deletes, everything that hangs off them) tagged with a `__wp1_test__` marker, and `cleanupTestOrgs()` deletes them in an `after()` hook. `test/helpers/build-app.js` builds one real app instance per test-runner process. `node:test` isolates each `.test.js` file in its own process, so there is no cross-file state, including per-route in-memory rate-limit counters. That is why the public-complaint tests still need distinct `x-forwarded-for` headers *within* one file.

`test/fixtures/junit/` holds real, sanitized output of Node's JUnit reporter (Node 20 and 24) for the report tests; see its README.

## Known limitations

- **`POST /tickets/:id/resolve`** (proof photo required) and successful worker resolve, verify and accept are **not covered yet**. This is no longer blocked by R2: `STORAGE_DRIVER=local` stores uploads on the filesystem with no cloud credentials, so these tests can now be written. See the coverage matrix for the full list of gaps and their priority.
- Email is never sent by the suite (SES is blanked). Tests can assert that a notification row was created, not that an email was accepted or delivered.
