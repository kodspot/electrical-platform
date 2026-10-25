# Data Model

How the domain is modelled and why. **The canonical, authoritative schema is
`apps/api/prisma/schema.prisma`** — it is commented and always current. This document does
*not* restate fields (that would drift); it explains the entity groups, the relationships,
the tenancy keying, and the lifecycle state machines that the schema alone doesn't make
obvious. Read them together.

32 models, 15 enums. Migrations live in `apps/api/prisma/migrations/` and are applied with
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
  `resetToken` (stored as a SHA-256 digest, never the e-mailed token), encrypted PII fields.
- `Worker` — electricians; PIN-hashed auth, `tokenInvalidBefore`, `resetToken` (digest, as for
  `User`), encrypted PII.
- `AuditLog` — append-only actor/action record (see the SA-audit rule in
  [auth-and-tenancy.md](auth-and-tenancy.md#the-one-cross-tenant-capability-superadmin-x-org-id)).
  - **What is recorded:** every staff change, and each successful sign-in, password or PIN
    change and reset (`signed_in`, `password_changed`, `password_reset`, `pin_changed`,
    `pin_reset`).
  - **What is not:** a failed sign-in. Anyone can cause one, and the rows would let them fill
    the table.
  - **No IP address or device** is stored.
  - **How rows are written:** through `services/audit.js`. `auditStaffAction(request, …)` is
    for a change by signed-in staff, with `actorType` from `auditActorType`, which tells a
    super admin acting in an org apart from the org's own staff. `auditAccountAction` is for
    an account acting on itself (BUG-0058).

**Module registry** (global, not tenant-scoped) — `ModuleDefinition`, `ModuleDependency`,
`OrgModuleActivation`. See [module-system.md](module-system.md).

**Locations & assignment** — `Location` (self-referential hierarchy via `parentId`, 32
`LocationType`s), `WorkerAssignment`, `SupervisorAssignment`. Coverage can be inherited
down the hierarchy (`coverChildren`), resolved by `services/assignment-resolver.js` with
recursive CTEs (Charter §7). Matches are returned in a stable order, and callers take the
first as the auto-assignee: direct assignment, then nearest ancestor, then `isPrimary`
(workers only), then oldest assignment (WP-H F2). Who is rung (walking up) and what an
electrician's app shows (walking down) follow the same tree. Both pass through deactivated
locations, because a location can be deactivated while its children stay active
(BUG-0050). The API requires `Worker.employeeId` on
creation and refuses to clear it, because worker login uses it (WP-H F8). The column stays
nullable, so existing rows are untouched.

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
- **Ticket transitions are compare-and-set on status.** Each lifecycle route (accept, pick up,
  resolve, verify, reopen, the electrician's pick up and resolve, the guest's review) writes
  through `updateTicketIfUnchanged` (`services/ticket-status.js`). The update applies only if
  the status is still the one the route checked, so two people acting at once cannot both
  win; the loser answers `409`. The admin's generic `PATCH` is an explicit override and stays
  unconditional (BUG-0038).
- **PII is encrypted at rest** via `lib/crypto.js` (AES-256-GCM), unconditionally (Charter
  §6). Encrypted fields: the Aadhaar number and blood group of workers and of users
  (supervisors), through `encryptPII` / `decryptPII`. Audit rows record that those two fields
  changed, never their values. Supervisor values were stored in plain text until BUG-0030;
  `scripts/migrate-user-pii.js` encrypts rows saved before the fix (`docs/DEPLOYMENT.md`).
- **Permanent deletes are dependency-guarded** — a worker or supervisor with inspection
  history is blocked (`409`) rather than silently disconnected (`[WP17]`). For a worker this
  also covers duty rosters, attendance records and resolved tickets (BUG-0035). Note that
  `DutyRosterWorker.workerId` is `ON DELETE RESTRICT`, so deleting an organization whose
  workers are on a roster fails unless the rosters are deleted first. Today org deletion is
  a soft delete; a future purge job must delete rosters first.
- **A user who is referenced cannot be hard-deleted.** Six foreign keys to `User` are
  `ON DELETE RESTRICT`: `Ticket.createdById`, `Attendance.markedById`, `DutyRoster.supervisorId`,
  `AssetEvent.loggedById`, `AssetFailure.loggedById` and `ElectricalInspection.supervisorId`.
  The schema declares `Ticket.createdBy` with `onDelete: Restrict` to match. `DELETE
  /supervisors/:id/permanent` pre-checks all six and answers `409` with the counts (F13,
  BUG-0009); it never lets the database reject the delete (which was a `500`).
  `assignedTo`, `verifiedBy` and `resolvedBy` are `SET NULL`; notifications and supervisor
  assignments cascade.
- **Ticket indexes beyond the obvious ones:** `(sourceIp, createdAt)` serves public-complaint
  duplicate scoring, and `(slaDeadlineAt, status)` and `(orgId, status, verifiedAt)` are kept
  for SLA and verification queries. Migration `20260426000000_phase1_sla_verify_provenance`
  created them; the schema has declared them since F13.
- **The schema and the migrations must agree (drift gate).** `npm run ci` (`ci-validate` →
  `scripts/schema-drift.js`) diffs the migrated CI database against `schema.prisma` and fails
  on any difference. The only exception is an allowlist of four implicit many-to-many
  join-table statements (`_ElectricalInspectionToWorker`, `_TicketResolvedWorkers`): Prisma 5
  models those with a unique index while the database has a primary key. **Remove that
  allowlist at the Prisma 6 upgrade.** A schema change therefore always ships with its
  migration.

## Related

- Canonical schema: `apps/api/prisma/schema.prisma`
- [overview.md](overview.md) · [auth-and-tenancy.md](auth-and-tenancy.md) ·
  [module-system.md](module-system.md) · [resilience.md](resilience.md)
- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §8, §8.1, §8.2
