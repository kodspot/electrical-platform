# Data Model

How the domain is modelled and why. **The canonical, authoritative schema is
`apps/api/prisma/schema.prisma`** — it is commented and always current. This document does
*not* restate fields (that would drift); it explains the entity groups, the relationships,
the tenancy keying, and the lifecycle state machines that the schema alone doesn't make
obvious. Read them together.

31 models, 15 enums. Migrations live in `apps/api/prisma/migrations/` and are applied with
`prisma migrate deploy` (Charter §8 — every schema change is a migration, no exceptions).

## Tenancy keying

`Organization` is the tenant root. Almost every other model carries `orgId` with an
org-first composite index. The few that don't are the module catalog and parent-scoped
child rows — see [auth-and-tenancy.md](auth-and-tenancy.md#which-models-are-not-tenant-scoped-and-why-thats-safe)
for the complete list and the safety argument. Deleting an `Organization` cascades to its
owned rows.

## Entity groups

**Tenant & access**
- `Organization` — tenant root; `status` (`ACTIVE`/`SUSPENDED`/`DELETED`), `enabledModules`
  (the runtime module gate), AI configuration.
- `User` — staff (`ADMIN`/`SUPERVISOR`/`SUPER_ADMIN`); `isActive`, `tokenInvalidBefore`,
  `resetToken`, encrypted PII fields.
- `Worker` — electricians; PIN-hashed auth, `tokenInvalidBefore`, `resetToken`, encrypted
  PII.
- `AuditLog` — append-only actor/action record (see the SA-audit rule in
  [auth-and-tenancy.md](auth-and-tenancy.md#the-one-cross-tenant-capability-superadmin-x-org-id)).

**Module registry** (global, not tenant-scoped) — `ModuleDefinition`, `ModuleDependency`,
`OrgModuleActivation`. See [module-system.md](module-system.md).

**Locations & assignment** — `Location` (self-referential hierarchy via `parentId`, 32
`LocationType`s), `WorkerAssignment`, `SupervisorAssignment`. Coverage can be inherited
down the hierarchy (`coverChildren`), resolved by `services/assignment-resolver.js` with
recursive CTEs (Charter §7).

**Tickets** — `Ticket` is the central workflow entity (see the lifecycle below). Sources:
internal or public (guest) complaint. `ComplaintCategory` defines per-org, optionally
per-hostel issue types.

**Electrical inspections** — `InspectionTemplate` → `InspectionTemplateItem` define the
checklist; `ElectricalInspection` → `ElectricalInspectionItem` + `ElectricalImage` record a
submission. An inspection links a supervisor, workers, a location, and a shift.

**Assets** — `Asset` (status/condition lifecycle) with `AssetEvent` (history),
`AssetFailure` (+ `AssetFailureImage`), `AssetImage`.

**Scheduling & attendance** — `ShiftConfig` (per-org shift windows; see
[resilience.md](resilience.md)), `Attendance`, `DutyRoster` → `DutyRosterWorker`.

**Automation & AI** — `AlertRule` → `Alert` (8 `AlertTrigger`s, dedup by day),
`AiInsight`, `AiUsageLog`.

## Lifecycle state machines

Enums encode several state machines the code enforces. The two that carry the most
business logic:

### Ticket status (`TicketStatus`, 9 states)

The canonical status groupings live in `services/ticket-status.js` (imported everywhere so
the rules can't drift):

- **Open-like:** `OPEN` → `ACKNOWLEDGED` → `ASSIGNED`
- **Active (open-like + in flight):** + `IN_PROGRESS`, `ON_HOLD`
- **Verify-pending:** `RESOLVED_PENDING_VERIFY` — reached **only** by a worker submitting
  resolution evidence; a generic admin PATCH may not set it directly (Charter §8.2, `[WP10]`).
- **Done:** `RESOLVED`, `CANCELLED`, `CLOSED`

A worker resolves → `RESOLVED_PENDING_VERIFY` (with a mandatory proof photo) → a supervisor
verifies → `RESOLVED`, or reopens → back to active. Moving a resolved/verified ticket back
to an active status clears its resolution/verification fields, matching the dedicated
`/reopen` endpoint — the generic editor must not leave a self-contradictory record (Charter
§8.2).

### Asset status (`AssetStatus`) vs. failures (`FailureStatus`)

An `Asset` cannot be hand-moved from `FAULTY` to `OPERATIONAL`/`UNDER_MAINTENANCE` while it
still has open `AssetFailure` records — that would make the asset's status contradict its
own failure history (Charter §8.2, rejected with `409`). Decommissioning is exempt.

### Organization status (`OrgStatus`)

`ACTIVE` is the only status that permits access; `SUSPENDED`/`DELETED` orgs are unreachable
everywhere authentication or page-serving happens (see
[auth-and-tenancy.md](auth-and-tenancy.md)).

## Data integrity rules

- **Multi-record writes that must agree use `$transaction`** (Charter §8.1) — e.g. an
  asset's status and its `AssetEvent`/`AssetFailure`.
- **PII is encrypted at rest** via `lib/crypto.js` (AES-256-GCM), unconditionally (Charter
  §6). Encrypted fields include worker/user Aadhaar and blood group.
- **Permanent deletes are dependency-guarded** — a worker or supervisor with inspection
  history is blocked (`409`) rather than silently disconnected (`[WP17]`).

## Related

- Canonical schema: `apps/api/prisma/schema.prisma`
- [overview.md](overview.md) · [auth-and-tenancy.md](auth-and-tenancy.md) ·
  [module-system.md](module-system.md) · [resilience.md](resilience.md)
- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §8, §8.1, §8.2
