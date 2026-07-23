# Test suite structure

Run with `npm test` (all files) from `apps/api/`. Uses Node's built-in `node:test` — no external test framework dependency.

## Tiers

**1. Unit tests** (`test/*.test.js` at the top level) — pure functions with no external dependency: permission-policy contract, tenant-context propagation, route-guard standardization, `lib/crypto.js` (PII encryption round-trip and tamper handling), `lib/security.js` (password rules, admin-key hashing), `services/ticket-status.js` (status-grouping invariants), `services/module-policy.js` (module-gating logic). These always run and must always pass.

**2. App smoke tests** (`test/integration/app-smoke.test.js`) — real HTTP-level requests via `fastify.inject()` against the fully-wired app (every plugin and route registered exactly as production does, via `buildApp()`/`registerApp()` in `index.js`), scoped to paths that reject a request *before* any database call is made: missing/forged/garbage auth tokens, `/health`'s graceful degradation when the database is unreachable, `/health/live`'s dependency-free response, input validation that happens ahead of a Prisma lookup, and `requestId` presence on error responses that flow through the centralized error handler. These always run and must always pass — they require no database.

**3. Database-backed integration tests** (`test/integration/tenant-isolation.test.js`, `ticket-lifecycle.test.js`, `public-complaint.test.js`) — real HTTP requests against real seeded data, proving the actual behavior these tests exist to protect: that one org can never see another org's tickets (Audit finding H1), that the ticket lifecycle transitions correctly through the real API, and that public complaint submission behaves correctly for guests. These require a reachable `DATABASE_URL` and check for one via `test/helpers/db.js#isDatabaseAvailable()` in a `before()` hook; every test in these files calls `t.skip()` with a clear message if no database is available, rather than failing or hanging. All 18 tests in this tier have been run and pass against a real, fully-migrated PostgreSQL instance.

**3b. Environment-aware tests** (`test/integration/health-ready.test.js`) — a different pattern from tier 3: instead of skipping when the database is unavailable, these check the real current state via `isDatabaseAvailable()` and assert whichever outcome that state implies (200/connected vs. 503/disconnected for `/health/ready`). They always run and always pass, in either environment, because `/health/ready`'s whole purpose is to correctly report both states.

Running this tier from the host machine against the project's own `docker-compose.yml` Postgres container requires overriding `DATABASE_URL`'s hostname (`db` → `127.0.0.1`), since `db` only resolves inside the compose network — pass a corrected `DATABASE_URL` as an environment variable when invoking `node --test`; don't hardcode a host override into the test files themselves, since that would break resolution inside CI/containers where `db` is the correct hostname.

**Database must be fully migrated** (`npx prisma migrate deploy`) before running this tier — it exercises current schema fields (e.g. ticket lifecycle status values added in `20260630010000_ticket_lifecycle_statuses`) that don't exist in an out-of-date database.

## Fixtures

`test/helpers/db.js` creates throwaway Organizations (and, via the schema's cascading deletes, everything that hangs off them — users, locations, tickets) tagged with a `__wp1_test__` marker in their name/slug, and cleans them up via `cleanupTestOrgs()` in an `after()` hook. `test/helpers/build-app.js` builds one real app instance per test-runner process (`node:test` isolates each `.test.js` file into its own process, so there's no cross-file state to worry about — including per-route in-memory rate-limit counters, which is why the public-complaint tests still need distinct `x-forwarded-for` headers *within* that one file).

## Known limitations

- `POST /tickets/:id/resolve` requires a mandatory proof-photo upload to R2 object storage and is not covered by the integration suite — testing it would need either real R2 credentials/network access in the test environment, or a mocking strategy for `lib/r2.js#uploadToR2`, neither of which is set up yet. This is the main remaining gap in ticket-lifecycle coverage.
- Running these tests against the real `.env` triggers real external side effects on routes that fire them (e.g. `public.js`'s `emailAdmins` call attempts a real SES send, which fails harmlessly since the sender identity isn't verified in this environment — the request itself is unaffected, since email sends are non-blocking by design). A dedicated test environment with stubbed external integrations would remove this noise before wiring this suite into CI.
