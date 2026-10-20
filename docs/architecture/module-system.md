# Module System

Business capability is divided into **modules** that an organization can have selectively
enabled. This is the platform's primary feature-gating and extensibility mechanism — new
business domains extend it rather than inventing a parallel scoping system (Charter §5).

## The four modules

Defined in `services/module-registry.js` (`DEFAULT_MODULE_DEFINITIONS`):

| Code | Name | Core? | Depends on |
|---|---|---|---|
| `ele` | Electrical | **yes** (cannot be disabled) | — |
| `civil` | Civil | no | `ele` |
| `asset` | Asset Management | no | `ele` |
| `complaints` | Complaints | no | `ele` |

`ele` is the core module every org must keep; the other three each depend on `ele`.
Dependencies are data-driven (`ModuleDependency` rows), not hardcoded branching, so the
dependency graph is validated uniformly.

## Two representations — and why there are two

There are deliberately two places module state lives, serving different needs:

1. **`Organization.enabledModules`** (a string array on the org row) — the **runtime gate**.
   `isModuleEnabled` (`services/module-policy.js`) reads it on every module-gated request
   via `requireModule`/`requirePolicy`. It is a fast, single-row read on the hot path.
2. **`ModuleDefinition` / `ModuleDependency` / `OrgModuleActivation`** (the **registry**) —
   the global module catalog plus a per-org **activation audit trail** (who activated/
   deactivated a module and when). This is the source of truth for *validation* and
   *history*, not the request-time gate.

Keeping the hot-path gate as a plain array avoids joining the registry on every request,
while the registry preserves the richer catalog/dependency/audit model. `[WP-era]` module
work keeps the two in sync through the activation flow below.

## Activation flow

When a SuperAdmin changes an org's modules (`routes/superadmin.js`):

1. **`validateActivationPlan`** (`services/module-registry.js`) checks the target set:
   non-empty, all codes known, no core module removed, all dependencies present, and no
   module deactivated while a dependent is still active. It returns structured error codes
   (`CORE_MODULE_REQUIRED`, `MISSING_DEPENDENCY`, `DEPENDENT_BLOCKS_DEACTIVATION`, …).
2. **`syncOrgModuleActivations`** writes the `OrgModuleActivation` rows (creating,
   reactivating, or marking deactivated with actor + timestamp).
3. The org's `enabledModules` array is updated to match — the runtime gate follows the
   validated plan.

`ensureModuleRegistry` runs at boot (`apps/api/index.js`) to upsert the default module
definitions and dependencies, so the catalog is always present.

## How gating reaches the request

- **Backend:** `requireModule('asset')` gates a whole route file; `requirePolicy(policy,
  { moduleCode })` combines role + module in one guard. Both resolve the org's
  `enabledModules` and reject with `403` if the module is off. SUPER_ADMIN bypasses module
  gating. See [auth-and-tenancy.md](auth-and-tenancy.md#authorization-the-policy-matrix).
- **Tickets carry a module, and only an enabled one:** `POST /api/tickets` answers `403` for a
  module the org has not enabled, and the unauthenticated `POST /api/public/complaint`
  answers `400` (BUG-0020) — the QR page offers only enabled modules, but a page left open
  while a module is switched off, or a crafted request, does not.
- **Frontend:** pages are served under module-scoped URLs (`/:orgSlug/:mod/...`) and each
  module gets its own PWA manifest and service worker. See
  [frontend.md](frontend.md#module-scoped-routing--pwa).

## Adding or changing a module

A new module is a registry entry (`DEFAULT_MODULE_DEFINITIONS` + any `ModuleDependency`),
its route files gated with `requireModule`, its pages added to the module page set
(`routes/pages.js`), and its default complaint categories (`services/complaint-categories.js`)
if it accepts complaints. Because gating is data-driven, no scoping logic is duplicated per
module.

## Related

- [overview.md](overview.md) · [auth-and-tenancy.md](auth-and-tenancy.md) ·
  [data-model.md](data-model.md) · [frontend.md](frontend.md)
- Code: `services/module-registry.js`, `services/module-policy.js`,
  `middleware/permission-policy.js`
