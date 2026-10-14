# CLAUDE.md — AI assistant orientation

Kodspot Electrical Platform: a multi-tenant (every row scoped by `orgId`) **Fastify 4 +
Prisma 5 / PostgreSQL** SaaS for electrical-inspection and facility-ticket management,
with server-rendered admin pages and an electrician/supervisor PWA under
`apps/api/public/`. Roles: guest → electrician (worker) → supervisor → admin →
super-admin.

**This file is a map, not a knowledge base.** It holds no facts that live elsewhere — it
points you at the canonical sources and states the invariants you must not break. When in
doubt, read the code: the repository is the source of truth.

## Where knowledge lives

- **Rules you must follow:** [`docs/ENGINEERING_CHARTER.md`](docs/ENGINEERING_CHARTER.md)
  — the Definition of Engineering; imperative, testable, with a dated Amendment Log of why
  each decision was made.
- **Documentation index / everything else:** [`docs/README.md`](docs/README.md).
- **Local dev, test, lint commands:** [`apps/api/README.md`](apps/api/README.md);
  tests and their safety guard: [`apps/api/test/README.md`](apps/api/test/README.md).
- **Known open production risks:**
  [`docs/history/production-readiness-audit-2026-07.md`](docs/history/production-readiness-audit-2026-07.md)
  and the characterisation findings in
  [`docs/testing/COVERAGE_MATRIX.md`](docs/testing/COVERAGE_MATRIX.md).

## How to work

- **Plan before non-trivial work.** Anything beyond a small, local fix (several files, a
  behaviour change, a new dependency, a security or data change): use plan mode, read the
  code first, and get the plan approved before editing.
- **Tests first for bug fixes:** write the test, show it failing on the old code, then fix.
- **Run test suites in a fresh, disposable copy against a disposable database.** The test
  guard (`apps/api/test/setup/`) refuses any database that isn't loopback and named
  `*_ci`, `*_test` or `*_e2e`; never point tests at a developer's or the production database.
- **Every fixed defect enters the bug registry:** a scenario module in
  [`apps/api/scenarios/bugs/`](apps/api/scenarios/bugs/) (one line in `registry.js`), run by
  `test/integration/bug-regressions.test.js`; regenerate
  [`docs/reference/bug-registry.generated.md`](docs/reference/bug-registry.generated.md)
  with `npm run docs:bugs` (in `apps/api`).
- **Finding IDs:** `PRA-07/Cn` = the 2026-07 production-readiness audit (critical findings
  C1…), `EP/Cn` = the engineering execution plan's items (`[WPn]` work packages in code
  comments and the Charter log), `Fn` = the characterisation findings in
  `docs/testing/COVERAGE_MATRIX.md`, `BUG-nnnn` = the bug registry.

## Where new code goes

Extend the existing structure; don't invent a parallel one (Charter §5).

- **Shape of the codebase** (routes / services / lib / middleware layering):
  [`docs/architecture/overview.md`](docs/architecture/overview.md).
- **A new business capability** extends the module system — modules are the extension
  mechanism, not a new scoping mechanism:
  [`docs/architecture/module-system.md`](docs/architecture/module-system.md) ("Adding or
  changing a module").
- **A new route** goes in a `routes/*.js` file, gated by `requirePolicy`/`requireModule`,
  and every tenant-owned query filters by `orgId`:
  [`docs/architecture/auth-and-tenancy.md`](docs/architecture/auth-and-tenancy.md). After
  adding/removing a route, regenerate the route index (`npm run docs:routes`).
- **Frontend:** server-rendered HTML with vanilla JavaScript — no bundler, no build step,
  no SPA framework: [`docs/architecture/frontend.md`](docs/architecture/frontend.md).
- **No Redis, job queue, message broker or second service without an ADR** — the
  platform is a modular monolith on one PostgreSQL:
  [`docs/adr/0002-modular-monolith.md`](docs/adr/0002-modular-monolith.md).
- **An architecturally significant decision** (new dependency, pattern deviation, security
  change) gets an ADR: [`docs/adr/README.md`](docs/adr/README.md).
- **When you change code, update the doc the Charter §22 trigger table names** — in the
  same change, with a `CHANGELOG.md` entry.

## Invariants you must never break

Each is enforced by the Charter and by the test suite; violating any is a defect, not a
style preference. Follow the link for the authoritative rule.

- **Tenant scoping.** Every query against a tenant-owned model filters by a *server-derived*
  `orgId` (from the verified JWT, never a client-supplied value). Mutations by bare `id`
  are preceded by an `orgId`-scoped ownership check. Another org's record answers **404**,
  never 403 (its existence is not disclosed). Charter §6.1.
- **Transactions.** Multi-record writes that must describe the same reality use
  `$transaction`. Charter §8.1.
- **Resilience is baked into shared primitives, not bolted on per call site** (e.g. the DB
  circuit breaker via a Prisma Client Extension, which counts only infrastructure errors;
  the shared AI provider module). Charter §8.3–§8.4,
  [`docs/architecture/resilience.md`](docs/architecture/resilience.md).
- **One notification interface.** A notification and its paired email go through the single
  `notify()` in `services/notification-service.js`, never as two independent calls. Charter §5.
- **PII encryption is unconditional** — routed through `lib/crypto.js`, never gated on
  `NODE_ENV`. Charter §6.
- **Signing secrets are validated for strength at boot**, not just presence. Charter §6.
- **No credential in a log line** (tokens travel in URLs for `<img>`/SSE): logging goes
  through `lib/log-redaction.js`. [`docs/MONITORING.md`](docs/MONITORING.md).
- **Nothing is done until lint passes clean and the full test suite passes.** Charter §19.

## Commands

From the **repository root** (see [`package.json`](package.json)):

| Command | What it does |
|---|---|
| `npm run ci` | The full gate CI runs: lint + all tests + repository checks (`apps/api`) |
| `npm run doctor` | Read-only local environment check (env, deps, dev database) |
| `npm run seed [profile]` | Rebuild a scenario profile (default: the demo organization) in the local dev database |
| `npm run scenario <name>` | Apply one named business scenario locally (`--list` lists them) |
| `npm run bug:list` / `bug:run` / `bug:validate` / `bug:test` | Work with the bug registry |
| `npm run release:check` | Release-readiness checks (`ci-validate --release`) |
| `npm run e2e` / `npm run e2e:ui` | Playwright browser suite on a disposable database ([`e2e/README.md`](e2e/README.md)) |

From **`apps/api/`**: `npm ci`, `npm test`, `npm run lint` — lint must stay at **0 errors**
(a small, stable set of pre-existing warnings is the baseline). Optional local pre-push
gate: `git config core.hooksPath .githooks` ([`.githooks/README.md`](.githooks/README.md)).

## Ground rules

- Prefer reading code over guessing; cite locations as `file.js:line` (clickable).
- When you change behavior, update the documentation the Charter §22 trigger table names —
  in the **same** change.
- Match the surrounding code's style and patterns; do not reformat unrelated code.
