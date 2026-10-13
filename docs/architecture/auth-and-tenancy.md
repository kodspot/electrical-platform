# Authentication, Authorization & Multi-Tenancy

The most security-critical part of the system. This explains *how* identity, permission,
and tenant isolation work and *why* they are shaped this way. The binding rules live in
[`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §6 and §6.1 (the Tenant-Scoping
Contract); this document is the explanation, and the two must agree.

## Identities

Two authenticated identity types, plus the unauthenticated public:

| Identity | Table | Token | Auth middleware |
|---|---|---|---|
| Staff user (`ADMIN`, `SUPERVISOR`, `SUPER_ADMIN`) | `User` | JWT, 24h | `authenticateJWT` (`middleware/auth.js`) |
| Worker / electrician | `Worker` | JWT, 30d | `authenticateWorkerJWT` (`routes/worker-auth.js`) |
| Guest (public complainant) | — | none | none — org resolved server-side |

Both JWTs are signed and verified with a single symmetric secret (`JWT_SECRET`, validated
for length at boot — Charter §6). There is no refresh-token flow; a longer 30-day worker
token reflects field devices that stay logged in.

## Authentication: verified on every request, not just at login

`authenticateJWT` does not trust the token's claims alone. On **every** request it:

1. Verifies the JWT signature.
2. Loads the `User` from the database and rejects if missing or `isActive === false` — so
   deactivating an account takes effect immediately, without waiting for token expiry.
3. Rejects tokens issued before `tokenInvalidBefore` — the mechanism that invalidates all
   existing sessions on a password/PIN change or reset (see the credential-recovery rule,
   Charter §6, from `[WP14]`).
4. For org-scoped users, re-checks that their `Organization.status === 'ACTIVE'` — a
   suspended or deleted org stops being reachable everywhere at once.

`authenticateWorkerJWT` mirrors this for workers, including the `tokenInvalidBefore` check.

## Brute-force protection on sensitive endpoints

Beyond the global rate limit (`plugins/security.js`, applied to all traffic), sensitive
unauthenticated endpoints carry a **stricter per-IP limit** from `middleware/rateLimits.js`:

- `loginRateLimit` — 10 requests / 15 min per IP, on login, to slow credential guessing.
- `strictRateLimit` — 5 requests / 15 min per IP (env-configurable via
  `ADMIN_RATE_LIMIT_MAX`/`ADMIN_RATE_LIMIT_WINDOW`, see
  [`../reference/environment.md`](../reference/environment.md)), on the highest-risk flows —
  password/PIN reset and public complaint submission — so a shared secret or the one
  unauthenticated write surface can't be hammered.

Both key off `req.ip` (honored correctly because `trustProxy` is set behind Caddy). This is
defense-in-depth layered on top of the credential-recovery anti-enumeration measures
(Charter §6) — the reset endpoints are both rate-limited *and* return identical
generic responses regardless of whether the account exists.

## The tenant-scoping model

**Every tenant-owned row carries `orgId`, and the `orgId` used in a query is always
server-derived, never client-supplied.** This is the single invariant the whole
multi-tenant guarantee rests on.

- The trusted `orgId` comes from `middleware/tenant-context.js`
  (`attachTenantContextFromUser` / `getTenantOrgId`), sourced from the verified JWT — never
  from a request body, query string, or path parameter. A client-supplied `orgId` may at
  most be *compared against* the trusted one to reject a mismatch.
- Every mutation by bare `id` is preceded by an `orgId`-scoped ownership check
  (`findFirst({ where: { id, orgId } })`) before the `update`/`delete`. A lookup that
  trusts `id` alone is a defect (Charter §6.1 item 2).

### Which models are *not* tenant-scoped, and why that's safe

Of the 32 models, only these lack `orgId`, each for a defensible reason:

- **`Organization`** — it *is* the tenant; it doesn't belong to one.
- **`QaRun`** — platform-level QA telemetry (one row per CI/local/e2e test run) for the
  super-admin Quality page. It describes the platform's code, not any tenant's data. It is
  written only by the token-authenticated ingest (`POST /api/qa/runs`) and read only by
  SUPER_ADMIN (`/api/superadmin/qa/*`). See ADR
  [0005](../adr/0005-qa-telemetry-in-production.md).
- **`ModuleDefinition`, `ModuleDependency`** — the global module *catalog*, system-wide by
  design (see [module-system.md](module-system.md)), not tenant data.
- **`DutyRosterWorker`, `AssetImage`, `AssetFailureImage`, `InspectionTemplateItem`,
  `ElectricalInspectionItem`, `ElectricalImage`** — child/junction rows reachable only
  through an `orgId`-scoped parent, and cascade-deleted with it. They are never queried by
  bare `id` outside their parent's org scope.

Everything else — users, workers, locations, tickets, inspections, assets, alerts,
attendance, notifications, audit logs, AI usage — carries `orgId` with an org-first
composite index.

`[WP7]` ran an exhaustive, file-by-file sweep verifying this contract and added regression
tests under `apps/api/test/integration/tenant-isolation*.test.js`; new tenant-owned routes
must ship with an equivalent test (Charter §6.1 item 8).

## Authorization: the policy matrix

Role checks are standardized through `requirePolicy(policyName)` (`middleware/auth.js`),
backed by the frozen policy table in `middleware/permission-policy.js`:

| Policy | Roles allowed | Requires org context | SA allowed |
|---|---|---|---|
| `SUPER_ADMIN` | SUPER_ADMIN | no | yes |
| `ORG_ADMIN` | ADMIN | yes | yes |
| `ORG_STAFF` | ADMIN, SUPERVISOR | yes | yes |
| `SUPERVISOR` | SUPERVISOR | yes | yes |
| `ADMIN_OR_SUPER_ADMIN` | ADMIN, SUPER_ADMIN | no | yes |

`requirePolicy` can also take a `moduleCode` to combine role + module gating in one guard.
`requireModule(code)` gates a whole route file on an org having a module enabled. Worker
routes layer an additional **location-coverage** check on top of `orgId` — a worker's org
membership alone does not authorize a ticket; `getWorkerCoverageLocationIds` must also
place the ticket in the worker's assigned locations (Charter §6.1 item 6).

## The one cross-tenant capability: SuperAdmin `X-Org-Id`

A `SUPER_ADMIN` may operate inside any organization by sending an `X-Org-Id` header.
`authenticateJWT` validates the target org is `ACTIVE` and, if so, sets the request's
effective `orgId` to it and records a `_saOrgSwitch` marker. This is the platform's **only
impersonation-like mechanism**, and it is fully audited:

- `registerSAuditHook` (`middleware/auth.js`) writes an `AuditLog` entry for **every**
  request made under `X-Org-Id` — reads (`sa_org_context_read`) as well as writes
  (`sa_org_context_write`). `[WP8]` closed the gap where only writes were logged; browsing
  an org's dashboard is almost all `GET` traffic, so excluding reads left most SA access
  untracked.
- Because those entries carry the real `orgId`, they surface in the affected org's own
  `GET /api/audit-logs` — cross-tenant access is visible to the org whose data was
  accessed, not only to the SuperAdmin.
- Routes under `routes/superadmin.js` identify their target org from an explicit path
  parameter, not the ambient header. No route outside `superadmin.js` should read
  `X-Org-Id` for authorization.

## Session storage in the browser

The four role dashboards store their tokens under **separate** localStorage keys
(`token`/`sa_token`/`sup_token`/`elec_token`) so multiple roles can be open in one browser
without clobbering each other; the SuperAdmin's selected org is `selectedOrgId`, sent as
`X-Org-Id`. See [frontend.md](frontend.md#sessions).

## Related

- Rules: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §6, §6.1
- [overview.md](overview.md) · [data-model.md](data-model.md) ·
  [module-system.md](module-system.md) · [frontend.md](frontend.md)
- Tests: `apps/api/test/integration/tenant-isolation*.test.js`,
  `superadmin-impersonation-audit.test.js`, `account-recovery.test.js`
