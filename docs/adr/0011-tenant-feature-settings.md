# 0011. Tenant feature settings: one validated, versioned settings document per organization

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** platform owner, engineering (PAR-10 review)

## Context

The [module system](../architecture/module-system.md) decides *which capabilities* an
organization has. Nothing decides *how they behave* for that organization. Every
behavioural number is a constant in code, the same for every institution. The 2026-10 review
([PAR-10 §7](../history/product-architecture-review-2026-10.md#7-modules-and-feature-settings))
lists them:
- the 30-minute guest review window (`tickets.js:580,666`);
- 5 complaints per 15 minutes per IP and 3 per location per 30 minutes
  (`public.js:185-192, 287-315`);
- 30-day photo retention (`cleanup.js:7`);
- shift windows, duplicated in three files (`shift-config.js:16-21`, `attendance.js:10-15`,
  `analytics.js:64-69`);
- the AI token cap.

A hostel whose residents share one campus address, a hospital ward and a college corridor need
different values. The post-resolution workflow ([ADR 0010](0010-configurable-post-resolution-workflow.md))
needs several of them.

Constraints:
- **Modules are the only scoping mechanism** for capabilities (Charter §5). Behaviour settings
  must not become a second one.
- **One PostgreSQL, no new service** ([ADR 0002](0002-modular-monolith.md)), and `orgId`
  scoping from the token ([ADR 0003](0003-shared-database-multi-tenancy.md)).
- **No deploy may change an existing org's behaviour** until that org's setting changes.

External guidance agrees on the split (PAR-10 §15.1-9):
- licence or tier entitlements are not feature flags;
- per-tenant special code is an antipattern;
- customisations should be configuration options open to every tenant.

## Decision

1. **Storage.** `Organization.settings` (JSONB, default `{}`) and `settingsVersion` (integer,
   default 0).
2. **One schema in code.** A single zod schema in `src/services/org-settings.js` declares every
   key with:
   - its type and bounds;
   - its default, which equals today's behaviour;
   - its scope: `org` keys are editable by org admins; `platform` keys, such as limits that
     protect the platform, are editable by the super-admin only;
   - for module-specific keys, the owning module.

   Unknown keys are rejected.
3. **Reads.** `getOrgSettings(orgId)` merges stored values over the defaults. A key whose
   module is off is ignored.
4. **Writes.** A dedicated route (`PATCH /api/org-settings`, `ORG_ADMIN`; platform keys
   `SUPER_ADMIN`) takes the expected `settingsVersion`. In one transaction it validates the
   value, increments the version and writes an AuditLog row with the before/after diff. A stale
   version answers 409.
5. **Keys are added only with a decision point and a test**, and the list stays short. Release
   toggles stay deploy-level; nothing in this document selects tenant-specific code.

## Alternatives considered

- **A key-value table (`OrgSetting(orgId, key, value)`).** This gives per-key audit and
  timestamps, but makes it harder to validate related keys together and to version them as a
  whole. It also adds a join on hot paths. It can be revisited if the settings grow large.
- **A column per setting.** This is typed in the database, but needs a migration for every
  knob and spreads validation across routes.
- **A hosted feature-flag service.** It is a new dependency and service (ADR 0002), and the
  wrong tool for durable per-tenant configuration and entitlements.
- **Modules as knobs** (for example a "long review window" module). This confuses
  entitlement with configuration, and the module registry would grow without bound.

## Consequences

- **Easier:** per-org behaviour changes without a deploy; validation and defaults live in one
  place; every change is audited and concurrent edits are detected.
- **Harder:**
  - The database cannot constrain the JSON. The code schema is the authority, and a renamed or
    reshaped key needs a small data migration.
  - Each new key costs a test at its decision point.
  - Any cached settings must be invalidated on write. That is simple on one instance; for
    several, see [`../SCALING.md`](../SCALING.md).
- **Commits future work to:**
  - an admin settings page;
  - schema unit tests (defaults, bounds, unknown keys);
  - one integration test per key;
  - the module-matrix e2e orgs (PAR-10 §7.4).
- **Reversal:** clearing a key returns it to its default. Dropping the feature means removing
  the schema keys and the two columns.

## Related

- [PAR-10 review](../history/product-architecture-review-2026-10.md): §7 (proposal, behaviour
  rules, migration and tests), §10 B-08, findings PAR-10/37, /43.
- [ADR 0010](0010-configurable-post-resolution-workflow.md): the first consumer.
- [`../architecture/module-system.md`](../architecture/module-system.md): entitlements, which
  this ADR leaves unchanged.
- [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §5 (extend existing structure).
