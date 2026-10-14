# 0007. A blocking dependency audit gate with expiring exceptions

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** owner (super-admin), engineering

## Context

The 2026-07 production-readiness audit (PRA-07/C1) found known-vulnerable runtime
dependencies and no CI step that ran `npm audit`, so a new advisory could reach `main`
unnoticed. Most findings were fixed in PR A:
- `npm audit fix`
- nodemailer upgraded to 10
- sharp upgraded to 0.35

Some cannot be fixed yet:
- the Fastify 4 chain (`fastify`, `find-my-way`, `@fastify/static`) needs the Fastify 5
  upgrade, a separate work package;
- `tar`, which arrives through bcrypt 5's install-time `node-pre-gyp`, needs bcrypt 6.

A plain `npm audit --audit-level=high` step would be red from day one. Silencing it
(`|| true`, or a lower level) would hide the next real advisory.

## Decision

We run `apps/api/scripts/audit-gate.js` in the deploy workflow's "Lint & Test" job, after
CI validation. It reads `npm audit --omit=dev --json`, which covers runtime dependencies
only.

**It fails when:**
- any **high or critical** advisory is not listed in `.github/audit-exceptions.json`
  (matched by GHSA id and package);
- any listed exception is past its `expires` date.

**Every exception is a dated decision**, recorded as
`{ghsa, package, severity, reason, owner, expires}`:
- the reason states whether the advisory is reachable at runtime, with `file:line`
  evidence;
- Fastify-chain entries expire after at most 60 days, everything else after at most 30.

**Network failures don't block:** a registry or network error prints a warning and passes,
so a registry outage cannot block a deploy. That code path is separate and tested.
Exceptions that no longer match any advisory produce a warning, so they can be removed.

## Alternatives considered

- **`npm audit --audit-level=high` with `continue-on-error`.** It never blocks, so it is a
  report nobody reads.
- **`--audit-level=critical` only.** The critical `tar` advisory would still need a waiver,
  and every high advisory (including the Fastify ones) would pass silently.
- **Dependabot or Renovate alone.** These are useful for proposing upgrades, but they don't
  stop a vulnerable lockfile from deploying, and they have no notion of a reviewed,
  expiring exception.

## Consequences

- **The gate will start failing.** A new high/critical advisory fails "Lint & Test", and
  therefore the deploy, until it is fixed or explicitly excepted with a reason and an
  expiry.
- **Exceptions force a decision.** When one expires (the `tar` entries in 30 days, the
  Fastify entries in 60), the build turns red. That deliberately forces either the upgrade
  or a renewed, dated decision.
- **Dev-only advisories are out of scope** (`--omit=dev`). The `e2e/` package is audited
  separately and isn't part of this gate.
- **Reversing it** means deleting the workflow step. The script has no other dependants.

## Related

- [`../../.github/audit-exceptions.json`](../../.github/audit-exceptions.json): the
  current exceptions.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md): what the CI job runs.
- [`../history/production-readiness-audit-2026-07.md`](../history/production-readiness-audit-2026-07.md),
  finding C1.
