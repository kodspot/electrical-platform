# Architecture Decision Records

An ADR records **one architecturally significant decision** — the context, the choice, the
alternatives weighed, and the consequences. ADRs answer *"why is it this way?"* years after
the people who decided have moved on.

## What an ADR owns (and what it doesn't)

The documentation layers deliberately separate concerns; keep them separate:

- **ADR** — the *decision* and its *alternatives*. Immutable once accepted.
- **[`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md)** — the *current rule* that
  results from decisions. Living, amended. The Charter links to ADRs; it does not restate
  their reasoning.
- **[`../architecture/`](../architecture/)** — *how* a thing works today. Links to the ADR
  for *why this approach*.

If you're about to explain a decision's alternatives in the Charter or an architecture doc,
write an ADR instead and link to it.

## When to write one

The trigger is Charter §22's ADR row: *an architecturally significant, hard-to-reverse
decision — a new dependency, a deviation from an established pattern (§5), or a change to
the security model (§6).* Routine feature work does not need an ADR. The Charter's dated
Amendment Log is the lightweight record for everything below that bar.

## Process

1. Copy [`0000-template.md`](0000-template.md) to the next number
   (`NNNN-short-kebab-title.md`).
2. Fill it in; open it as `Proposed`.
3. On acceptance at review, set `Accepted`. **After acceptance an ADR is never edited.**
4. A reversal is a *new* ADR that supersedes the old one — set the old one's status to
   `Superseded by NNNN` (the only permitted post-acceptance change) and reference it from
   the new one.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-offsite-backup-storage.md) | Offsite backup storage on Cloudflare R2 | Accepted |
| [0002](0002-modular-monolith.md) | Modular monolith over microservices | Accepted |
| [0003](0003-shared-database-multi-tenancy.md) | Shared-database, `orgId`-scoped multi-tenancy | Accepted |
| [0004](0004-resilience-as-shared-primitives.md) | Resilience baked into shared primitives | Accepted |
| [0005](0005-qa-telemetry-in-production.md) | QA telemetry in the production DB, token-authenticated ingest, outbound GitHub calls | Proposed |
| [0006](0006-browser-e2e-with-playwright.md) | Browser end-to-end tests with Playwright in a separate `e2e/` package | Proposed |
| [0007](0007-dependency-audit-gate.md) | A blocking dependency audit gate with expiring exceptions | Proposed |
| [0008](0008-runtime-upgrade-node24-fastify5.md) | Runtime upgrade: Node 24, Fastify 5, bcrypt 6 | Proposed |
| [0009](0009-post-deploy-production-smoke.md) | A read-only production smoke after every deploy and nightly | Proposed |
| [0010](0010-configurable-post-resolution-workflow.md) | A post-resolution workflow that reaches the resident, with configurable alternatives | Proposed |
| [0011](0011-tenant-feature-settings.md) | Tenant feature settings: one validated, versioned settings document per organization | Proposed |

> ADRs 0002–0004 were backfilled to record foundational decisions the codebase already
> embodies; they are dated to their authoring, and each notes that it documents a
> pre-existing decision rather than a new one.
