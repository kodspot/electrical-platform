# Documentation Index

The map of the Kodspot Electrical Platform engineering knowledge base. Everything is
reachable from here in at most two hops. New to the codebase? Follow the reading path.
Otherwise, jump to the layer you need.

The repository is the single source of truth. Each fact has exactly **one** canonical
home; every other mention links to it rather than restating it.

---

## Reading path (new engineers)

1. [Root `README.md`](../README.md) — what this project is and how the repo is laid out.
2. [`ENGINEERING_CHARTER.md`](ENGINEERING_CHARTER.md) — the rules every change is held to
   (skim §1–§8 first; it is imperative and testable).
3. [`architecture/overview.md`](architecture/overview.md) — how the system fits together;
   then [`architecture/auth-and-tenancy.md`](architecture/auth-and-tenancy.md), the most
   security-critical concept.
4. [`apps/api/README.md`](../apps/api/README.md) — get it running locally; test and lint
   commands.
5. Reference and operations material below, as needed.

---

## Layers

The knowledge base is organized into five layers. The layer a fact belongs to tells you
where it lives.

### Governance — the rules
- [`ENGINEERING_CHARTER.md`](ENGINEERING_CHARTER.md) — the Definition of Engineering for
  this project: coding, security, tenancy, database, testing, deployment standards, plus
  a dated **Amendment Log** that is the authoritative record of *why* each significant
  decision was made.

### Architecture — how & why
Engineering understanding, not code duplication. Each links to the code it describes.
- [`architecture/overview.md`](architecture/overview.md) — system shape, stack, request
  lifecycle, structure. **Start here.**
- [`architecture/auth-and-tenancy.md`](architecture/auth-and-tenancy.md) — authentication,
  authorization, multi-tenancy, the SuperAdmin cross-tenant capability.
- [`architecture/data-model.md`](architecture/data-model.md) — entity groups,
  relationships, tenancy keying, lifecycle state machines.
- [`architecture/module-system.md`](architecture/module-system.md) — the
  `ele`/`civil`/`asset`/`complaints` module registry and gating.
- [`architecture/notifications.md`](architecture/notifications.md) — the notification
  subsystem end to end: `notify()`, persistence, real-time SSE delivery, poll fallback.
- [`architecture/resilience.md`](architecture/resilience.md) — circuit breakers, scheduler
  locks, scheduled jobs, error handling.
- [`architecture/frontend.md`](architecture/frontend.md) — PWA patterns, role-scoped
  sessions, module-scoped routing, offline sync.

### Reference — precise facts
- [`.env.example`](../.env.example) — the canonical list of environment variables (values
  and formats); [`reference/environment.md`](reference/environment.md) adds their semantics
  (required?, validated how, what each controls).
- [`reference/routes.generated.md`](reference/routes.generated.md) — the full route index,
  **generated** from Fastify's route table (`node scripts/gen-route-index.js`), never
  hand-edited.
- [`reference/bug-registry.generated.md`](reference/bug-registry.generated.md) — the bug
  reproduction library: every fixed defect with metadata, reproduction steps, and a
  regression test. **Generated** from `apps/api/scenarios/bugs/` (`npm run docs:bugs`).
- The Prisma schema (`apps/api/prisma/schema.prisma`) is the canonical, commented source
  for the data model — read it directly rather than a hand-maintained copy.
- [`apps/api/README.md`](../apps/api/README.md) — local development, test, and lint
  commands. [`apps/api/test/README.md`](../apps/api/test/README.md) — test-tiering strategy.
- [`testing/COVERAGE_MATRIX.md`](testing/COVERAGE_MATRIX.md) — what the automated suite
  does and does not cover, per workflow, module, route file and scheduled job (QA-1 snapshot).
- [`testing/TESTING.md`](testing/TESTING.md) — what runs when: every automated check, its
  trigger, whether it fails the build, and where its result appears; the PR change impact
  report.

### Operations — run, recover, scale
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — CI/CD, staging, and production deploy flow.
- [`MONITORING.md`](MONITORING.md) — health endpoints, error alerting, logs, known gaps.
- [`RUNBOOKS.md`](RUNBOOKS.md) — incident playbooks (rollback, DB / AI / R2 outage).
- [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) — backup/restore strategy and drill
  record.
- [`SCALING.md`](SCALING.md) — connection-pool sizing and scaling guidance.

### Decisions & History
- [`releases/`](releases/) — release notes; [`v1.0.0-draft.md`](releases/v1.0.0-draft.md) is the
  draft for the first tagged release (not yet tagged); [`next-draft.md`](releases/next-draft.md)
  collects the changes since v1.0.0.
- [`adr/`](adr/) — Architecture Decision Records; see [`adr/README.md`](adr/README.md) for
  the index and process. Foundational: modular monolith, shared-DB tenancy, resilience
  primitives, offsite backup storage.
- [`history/production-readiness-audit-2026-07.md`](history/production-readiness-audit-2026-07.md)
  — a frozen, dated snapshot of known production risks after WP17.
- [`history/product-architecture-review-2026-10.md`](history/product-architecture-review-2026-10.md)
  — a dated product and architecture review (findings `PAR-10/n`): how the product fits real
  colleges and hostels, a prioritised backlog, and the decisions for the owner. Its proposals
  are ADRs 0010 and 0011 (Proposed).

### Chronology
- [`CHANGELOG.md`](../CHANGELOG.md) — every merged change, dated and Work-Package-tagged.

### For AI assistants
- [`CLAUDE.md`](../CLAUDE.md) — orientation and the load-bearing invariants an assistant
  must not violate. It is a map of links, not a second copy of any fact.

---

## Conventions

Rules for keeping this knowledge base accurate and maintainable for years:

- **One canonical owner per fact.** No two documents own the same knowledge. If you find
  yourself restating something, link to its home instead. The layer model above is how
  ownership is assigned (e.g., a rule lives in the Charter; the reasoning behind a
  significant decision lives in an ADR; a value lives in `.env.example` or the schema).
- **Explain, don't duplicate code.** Documentation describes intent and structure and
  links to the implementation (`file.js:line`). It never restates what the code, schema,
  or `.env.example` already says — those are their own canonical source.
- **Generate over hand-maintain** anything that mirrors a machine-readable source (route
  lists, schema diagrams). A hand-written mirror drifts; a generated one cannot.
- **Docs change in the same pull request as the code they describe.** The Charter's §22
  Documentation Policy trigger table says which doc a given change must update; §16/§19
  make it part of the Definition of Done. If no update is needed, say so explicitly.
- **Relative links only**, so the tree stays portable across GitHub, editors, and tools.
- **ADRs are append-only.** A decision is never edited after acceptance; a reversal is a
  new ADR that supersedes the old one. `history/` is frozen the same way — a new audit or
  record is a new file, never an edit of an old one.
