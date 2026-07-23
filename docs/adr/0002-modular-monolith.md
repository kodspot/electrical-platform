# 0002. Modular monolith over microservices

- **Status:** Accepted
- **Date:** 2026-07-21 (backfilled — records a foundational decision the codebase already embodies)
- **Deciders:** Engineering lead / architect

## Context

The platform serves multiple organizations across several business modules
(`ele`/`civil`/`asset`/`complaints`) with a small engineering team and a single-VM
deployment target. A structural choice was needed: one deployable application, or a set of
independently-deployed services. This decision shapes deployment, data access, transaction
boundaries, and how new capability is added.

## Decision

We build and deploy a **modular monolith**: one Node/Fastify process, one PostgreSQL
database, with internal boundaries enforced by module structure (`services/`, the module
registry, `orgId` tenancy) rather than by network calls. New business capability extends the
existing module system and tenant model rather than introducing a parallel service.

## Alternatives considered

- **Microservices (per-module or per-domain services).** Rejected for this stage:
  independent services buy independent scaling and deployment at the cost of network
  latency, distributed transactions, cross-service auth, and operational overhead that a
  small team on a single VM cannot justify. The product's transactional consistency needs
  (e.g. an asset's status and its failure records must agree — see
  [`../architecture/data-model.md`](../architecture/data-model.md)) are far simpler inside
  one database than across services.
- **Serverless functions.** Rejected: the app relies on in-process scheduled jobs and
  long-lived patterns (SSE, connection pooling) that fit a persistent process, not
  cold-start function invocations.

## Consequences

- **Easier:** local transactions, a single deploy, one place to reason about auth and
  tenancy, low operational cost.
- **Harder / constrained:** the whole app scales as one unit (see
  [`../SCALING.md`](../SCALING.md)); there is no per-module fault isolation at the process
  level (mitigated by circuit breakers and per-job error isolation, see
  [`0004-resilience-as-shared-primitives.md`](0004-resilience-as-shared-primitives.md)).
- **Commitment:** any move toward a job queue, an event bus, Redis, or a second service is
  an architecture change requiring a new ADR, not a per-PR choice — this is codified as
  Charter §5.

## Related

- Rule: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §5 (Architecture Preservation)
- Mechanism: [`../architecture/overview.md`](../architecture/overview.md),
  [`../architecture/module-system.md`](../architecture/module-system.md)
