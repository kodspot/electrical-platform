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
- **Local dev, test, lint commands:** [`apps/api/README.md`](apps/api/README.md).
- **Known open production risks:**
  [`docs/history/production-readiness-audit-2026-07.md`](docs/history/production-readiness-audit-2026-07.md).

## Where new code goes

Extend the existing structure; don't invent a parallel one (Charter §5).

- **Shape of the codebase** (routes / services / lib / middleware layering):
  [`docs/architecture/overview.md`](docs/architecture/overview.md).
- **A new business capability** extends the module system, not a new scoping mechanism:
  [`docs/architecture/module-system.md`](docs/architecture/module-system.md) ("Adding or
  changing a module").
- **A new route** goes in a `routes/*.js` file, gated by `requirePolicy`/`requireModule`,
  and every tenant-owned query filters by `orgId`:
  [`docs/architecture/auth-and-tenancy.md`](docs/architecture/auth-and-tenancy.md). After
  adding/removing a route, regenerate the route index (`npm run docs:routes`).
- **An architecturally significant decision** (new dependency, pattern deviation, security
  change) gets an ADR: [`docs/adr/README.md`](docs/adr/README.md).
- **When you change code, update the doc the Charter §22 trigger table names** — in the
  same change.

## Invariants you must never break

Each is enforced by the Charter and by the test suite; violating any is a defect, not a
style preference. Follow the link for the authoritative rule.

- **Tenant scoping.** Every query against a tenant-owned model filters by a *server-derived*
  `orgId` (from the verified JWT, never a client-supplied value). Mutations by bare `id`
  are preceded by an `orgId`-scoped ownership check. Charter §6.1.
- **Transactions.** Multi-record writes that must describe the same reality use
  `$transaction`. Charter §8.1.
- **Resilience is baked into shared primitives, not bolted on per call site** (e.g. the DB
  circuit breaker via a Prisma Client Extension; the shared AI provider module). Charter §8.3–§8.4.
- **One notification interface.** A notification and its paired email go through the single
  `notify()` in `services/notification-service.js`, never as two independent calls. Charter §5.
- **PII encryption is unconditional** — routed through `lib/crypto.js`, never gated on
  `NODE_ENV`. Charter §6.
- **Signing secrets are validated for strength at boot**, not just presence. Charter §6.
- **Nothing is done until lint passes clean and the full test suite passes.** Charter §19.

## Commands (run from `apps/api/`)

- Install: `npm ci`
- Test: `npm test` — Node's built-in runner; DB-backed integration tests skip cleanly when
  no `DATABASE_URL` is reachable.
- Lint: `npm run lint` — must stay at **0 errors** (a small, stable set of pre-existing
  warnings is the baseline).

## Ground rules

- Prefer reading code over guessing; cite locations as `file.js:line` (clickable).
- When you change behavior, update the documentation the Charter §22 trigger table names —
  in the **same** change.
- Match the surrounding code's style and patterns; do not reformat unrelated code.
