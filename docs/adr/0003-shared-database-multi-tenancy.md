# 0003. Shared-database, `orgId`-scoped multi-tenancy

- **Status:** Accepted
- **Date:** 2026-07-21 (backfilled — records a foundational decision the codebase already embodies)
- **Deciders:** Engineering lead / architect

## Context

One deployment serves many organizations (tenants). Their data must be strictly isolated —
a tenant must never see or mutate another's — while keeping operations manageable for a
small team on a single database. The isolation model is the most security-critical
architectural choice in the system.

## Decision

We use a **single shared database with row-level tenant scoping**: nearly every table
carries an `orgId` column with an org-first composite index, and every query against a
tenant-owned model filters by a **server-derived** `orgId` (from the verified JWT, never a
client-supplied value). `Organization` is the tenant root; the only tables without `orgId`
are the global module catalog and child rows reached solely through an `orgId`-scoped
parent.

## Alternatives considered

- **Database-per-tenant.** Rejected: strongest isolation, but operationally heavy —
  migrations, backups, connection pools, and provisioning multiply per tenant, untenable for
  a small team and a single-VM target, and wasteful for many small tenants.
- **Schema-per-tenant (one PostgreSQL schema each).** Rejected: lighter than db-per-tenant
  but still multiplies migration/connection management and complicates cross-tenant
  SuperAdmin operations, for isolation that disciplined row scoping already provides.
- **Application-only scoping with no `orgId` on rows.** Rejected as unsafe: isolation would
  depend entirely on every query remembering a filter with no columnar backstop or
  index-enforced pattern.

## Consequences

- **Easier:** one schema, one migration path, one connection pool; cross-tenant SuperAdmin
  operation is a scoped `X-Org-Id` switch, not cross-database plumbing.
- **Harder / constrained:** isolation is only as strong as the discipline of always
  filtering by the server-derived `orgId`. This is deliberately backed by a written
  contract, an exhaustive verification sweep, and regression tests — see
  [`../architecture/auth-and-tenancy.md`](../architecture/auth-and-tenancy.md) and Charter
  §6.1. A leak is a code defect, caught by `tenant-isolation*.test.js`.
- **Commitment:** every new tenant-owned model carries `orgId` and ships with an isolation
  test; every mutation by bare `id` is preceded by an `orgId`-scoped ownership check.

## Related

- Mechanism & contract: [`../architecture/auth-and-tenancy.md`](../architecture/auth-and-tenancy.md)
- Rule: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §6.1 (the Tenant-Scoping Contract)
- Data model: [`../architecture/data-model.md`](../architecture/data-model.md)
