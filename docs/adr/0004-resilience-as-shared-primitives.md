# 0004. Resilience baked into shared primitives

- **Status:** Accepted
- **Date:** 2026-07-21 (backfilled — records a decision arrived at during `[WP12]`/`[WP10]`)
- **Deciders:** Engineering lead / architect

## Context

The system depends on external resources that fail independently of it: PostgreSQL, AI
providers, and (for scheduled jobs) the correctness of running exactly once even if more
than one instance is deployed. An earlier state had circuit breakers that *existed* and
were reported on `/health` but were wired into almost nothing — decorative resilience. The
question: where does resilience live so that it is actually in force on every relevant call,
not dependent on each author remembering to add it?

## Decision

**Resilience is baked into shared primitives that callers get for free, not opt-in wrappers
at each call site.**

- **Database:** every Prisma operation is routed through `dbBreaker` automatically via a
  **Prisma Client Extension** in `lib/prisma.js`. Route code uses the shared `prisma` export
  and is protected without doing anything.
- **AI providers:** `aiBreaker.exec(...)` is wrapped *inside* the single shared
  `callAiProvider` (`lib/ai-provider.js`), so every AI caller is protected by construction.
- **Scheduled jobs:** run-once-across-instances is a property of the job invocation
  (`runExclusive` + PostgreSQL advisory locks in `lib/scheduler-lock.js`), not something
  reasoned about per job.

## Alternatives considered

- **Per-call-site wrappers** (each query/AI call wrapped by hand). Rejected: this is exactly
  the state that failed — coverage depended on memory, and the AI breaker ended up wired into
  a background job but not the live endpoints. A primitive a caller can forget is not
  reliable resilience.
- **Redis (or another external coordinator) for scheduler locking.** Rejected: it adds
  infrastructure the modular-monolith deployment
  ([`0002-modular-monolith.md`](0002-modular-monolith.md)) deliberately avoids, when the
  database every instance already shares provides advisory locks that do the job.
- **A library-level resilience framework.** Rejected as over-engineered for two breakers and
  a lock; the small hand-rolled `CircuitBreaker` is testable and sufficient.

## Consequences

- **Easier:** new route and AI code inherits protection with no ceremony; there is no
  "did we wrap this?" review question for the DB path.
- **Harder / constrained:** the protection is somewhat invisible, so a maintainer must not
  bypass the shared `prisma`/`callAiProvider`/`runExclusive` primitives — documented in
  [`../architecture/resilience.md`](../architecture/resilience.md) precisely so it isn't
  removed by accident. Scope caveat: the DB extension covers per-model operations, not
  `$queryRaw`/`$transaction` as top-level client methods (statements *inside* a transaction
  are covered).
- **Commitment:** when building any new resilience primitive, verify its actual call sites,
  not just its existence (Charter §8.3).

## Related

- Mechanism: [`../architecture/resilience.md`](../architecture/resilience.md)
- Rule: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §8.3, §8.4
- Depends on: [`0002-modular-monolith.md`](0002-modular-monolith.md) (no external infra)
