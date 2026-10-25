# Engineering Implementation Charter
### Kodspot Electrical Platform — the Definition of Engineering for this project

**Status:** Active · **Applies to:** `apps/api` (the entire application) · **Supersedes:** ad hoc practice
**Precedence:** explicit, live instruction from the project owner in a given session always overrides this Charter. Where no explicit instruction is given, this Charter governs.

This Charter exists because the [Production Readiness Audit](#) found a product with sound business logic and no consistent process discipline around changing it. It converts the lessons of that audit and the [Engineering Execution Plan](#) into standing rules. It is written to be read before every future work package — including Work Package 1 — not filed away after being read once.

---

## How to use this document

Before starting **any** implementation work in this repository:

1. Read the section relevant to what you're about to touch (route change → §6 Security, §9 API Compatibility; schema change → §8 Database Safety; UI change → §10–11).
2. Follow the mandatory workflow in **§21** end to end.
3. Run the **Definition of Done** (§19) and **Code Review Checklist** (§20) before calling anything finished.
4. Run the **Documentation Policy** (§22) trigger table for every artifact type before merging.

Nothing below is aspirational. Every rule traces back to a specific, already-observed failure mode in this codebase (cited inline) or a specific finding from the Production Readiness Audit (cited as `[C#/H#/M#/L#]`) or Execution Plan (cited as `[WP#]`).

---

## 1. Repository Analysis Before Coding

- **Re-derive current state from the live repository, not from memory of a prior discovery pass.** The onboarding report and audit are point-in-time snapshots; the code may have moved since. Read the actual current file before editing it.
- Before touching a route, identify: which middleware chain gates it (`authenticateJWT`/`authenticateWorkerJWT` + `requirePolicy`/`requireModule`), which Prisma models it reads/writes, which service functions it calls, and which frontend pages consume it.
- Before touching a Prisma model, read the full `schema.prisma` block for that model and every model it relates to — not just the field being changed.
- Cross-reference the Production Readiness Audit and Execution Plan for any open finding touching the same file before starting unrelated work there, to avoid two independent fixes colliding.
- **No implementation begins without an explicit, written statement of current behavior vs. desired behavior.** If you cannot state both precisely, you do not yet understand the change well enough to start.

## 2. Root Cause Analysis

- Every bug fix must trace the defect to its actual origin, not its symptom location. This codebase's layering is route → service → lib; a bug observed in a route's response may originate in a shared service (e.g. `assignment-resolver.js`, `notification-service.js`) — fix it where it originates, not where it's noticed.
- Classify every reported issue as one of: **defect** (behavior contradicts intended design), **missing feature** (no defect, just absent capability), or **surprising-but-intentional** (works as designed, but the design itself needs a decision). Each requires a different response — do not silently convert one into another.
- Document the root cause in the implementation summary (workflow step 10, §21) in plain language, so the next engineer doesn't have to rediscover it from a diff.
- **Do not patch a symptom to make a specific report go away** if the same root cause will resurface elsewhere. If the fix genuinely must be local (time-boxed, low-risk area), say so explicitly and note the deferred root-cause work.

## 3. Implementation Planning

- Every non-trivial change gets a short written plan before code is touched: scope, files to be touched, chosen approach, and — explicitly — what is **out of scope**. Use the harness's Plan Mode for anything beyond a one-line fix, so the plan is reviewed and approved before implementation starts, not narrated after the fact.
- Reference the relevant Execution Plan work package ID and Audit finding ID in the plan where applicable, so the change is traceable back to why it exists.
- **Prefer the smallest safe change that fully addresses the root cause.** Do not bundle opportunistic refactors, renames, or "while I'm in here" cleanups into a fix or feature PR — file them as separate, explicitly-scoped work (this matches the project's existing house style: no abstractions beyond what the task requires, no speculative future-proofing).
- If a plan reveals the smallest safe change is still large (e.g. touches every route file, or every HTML page), say so up front rather than discovering it mid-implementation.

## 4. Coding Standards

- Match the existing conventions in the file being edited before introducing new ones. This codebase is a **route-per-resource Fastify plugin** pattern with **direct Prisma calls in route handlers** and a **services layer reserved for cross-route-reused or scheduled logic** — do not introduce a repository layer, a DI container, or a competing pattern in the course of an unrelated fix.
- New validation follows the existing partial-Zod convention (formalize incrementally, don't retrofit an entire file's validation as a side effect of one endpoint change).
- New non-critical side effects (notifications, audit-log writes, alert evaluation) follow the existing fire-and-forget convention (`.catch(() => {})`) so a secondary effect never fails the primary request — but only for genuinely non-critical effects; do not apply this pattern to anything the primary operation's correctness depends on.
- **No comments unless they explain a non-obvious WHY** — a hidden constraint, a workaround, a subtle invariant. Do not describe WHAT the code does; well-named identifiers already do that.
- Do not reformat or restyle unrelated code in the same change. Once §12's linter/formatter (Execution Plan `[WP2/M2]`) is in place, all new code must pass it clean.

## 5. Architecture Preservation

- This is a **modular monolith** by deliberate choice, appropriate to the product's current stage (Architecture Analysis, §4). Do not fragment it into competing patterns piecemeal — a shift to a repository layer, an event bus, or a job queue is an architecture decision, not a per-PR judgment call, and requires an ADR (§17, §22) before it starts.
- New business capability should extend the existing **module system** (`ele` / `civil` / `asset` / `complaints`, governed by `module-registry.js` / `module-policy.js`) and the existing **tenant model** (`orgId`-scoped everywhere) rather than inventing a parallel mechanism for scoping or feature-gating.
- Extract to `src/services/` only when a second call site for the same logic actually appears, or when logic must run on a schedule — not preemptively. This mirrors the codebase's existing, intentional restraint.
- Any deviation from an established pattern (e.g. introducing a job queue, introducing Redis, introducing a second auth transport) requires an ADR explaining why the existing pattern was insufficient.
- **A notification and its paired email (or any future channel) are triggered through one call, not two independently maintained ones.** `[WP15]` found `tickets.js` and `public.js` each called an in-app/SSE notification function (`services/notification-service.js`) and an email function (`lib/email.js`) as two separate, independently-written statements per event — easy for a future edit to update one and forget the other. `services/notification-service.js`'s `notify({ orgId, to, type, title, body, entityId, isUrgent, email })` is now the single entry point: `to` selects the audience via `NOTIFY_CHANNELS` (`userId`/`workerId`/`admins`/`supervisors`/`supervisorIds`/`workerIds` — the same underlying functions as before, just dispatched from one table), and an optional `email` block (`{ to, subject, html }` or `{ toAdmins, subject, html }`) sends the paired email through the existing `lib/email.js` helpers. `notify()` never rejects (matching the fire-and-forget convention every call site it replaces already used). Adding a future channel (SMS, push) is a single addition to `NOTIFY_CHANNELS`, not a new statement at every call site that needs it — use this pattern for any new notification+email pairing rather than writing the two calls separately.

## 6. Security Requirements

- **Every new or modified route must pass through the existing auth stack** — `authenticateJWT` or `authenticateWorkerJWT`, plus `requirePolicy(...)` and/or `requireModule(...)` as appropriate. No route bypasses this chain, including "internal" or "temporary" routes.
- **Every new or modified query against a tenant-owned model must include an org-scope filter**, sourced from `getTenantOrgId(request)` or the equivalent `request.user.orgId` / `request.worker.orgId`. This is now a mandatory, explicit code-review checklist item — not an assumption. *(Closes the gap behind Audit finding [H1], Execution Plan [WP7].)*

### 6.1 The Tenant-Scoping Contract

`[WP7]` ran an exhaustive, file-by-file, query-by-query manual sweep of every route file against this rule (backed by `middleware/tenant-context.js` and automated regression tests under `test/integration/tenant-isolation*.test.js`) and found no exploitable cross-tenant leak. This subsection is the durable, written form of what that sweep verified — the contract every future query must keep satisfying, not just a one-time audit result.

1. **The org identifier is always server-derived, never client-supplied.** The only legitimate sources of the `orgId` used in a query are: `request.user.orgId` (set by `authenticateJWT` from the verified JWT), `request.worker.orgId` (set by `authenticateWorkerJWT`), or `getTenantOrgId(request)` (the helper that also handles the SUPER_ADMIN override below). A value named `orgId` arriving in a request body, query string, or URL param is never trusted as an authorization boundary — at most it may be compared *against* the server-derived value to reject a mismatch (as `tickets.js`'s `assignedToId` cross-org check and `duty-roster.js`'s worker-list validation do).
2. **Every mutation by bare `id` is preceded by an ownership check scoped to `orgId`.** The pattern is `findFirst({ where: { id, orgId, ... } })` (or an equivalent combined `where` on the `update`/`delete` call itself) before any `update`/`delete`/`updateMany`/`deleteMany`. A lookup that trusts `id` alone and defers scoping to a later step is not acceptable, even if nothing currently races it.
3. **`id`-in-list lookups fed by an already-org-scoped upstream query still carry a local `orgId` filter where the cost is negligible.** `[WP7]`'s sweep found several queries (`workers.js`, `services/predictions.js`, `analytics.js`, `audit-logs.js`, `duty-roster.js`) that were safe *only* because the id list feeding them was itself produced by an earlier org-scoped query — correct today, but one accidental refactor away from becoming a leak with no local signal of the break. These were hardened to filter on `orgId` directly, and that's now the expected default: don't rely on an invariant one call site away when the redundant filter costs nothing.
4. **The SUPER_ADMIN cross-org override is the one deliberate exception, and it is narrow.** `middleware/auth.js` allows a `SUPER_ADMIN`-role JWT to set the effective `orgId` via an `X-Org-Id` header, consumed through `getTenantOrgId(request)`. Every route under `routes/superadmin.js` is gated by `requirePolicy('SUPER_ADMIN')` and identifies the org it's acting on from an explicit `:id`/`:orgId` path parameter, not an ambient header — a route that mixes the two (accepting both a path org and a header org for the same operation) is a bug, not a feature. No route outside `superadmin.js` should read `X-Org-Id` for authorization purposes.
5. **Unauthenticated routes (`public.js`) resolve their org from a server-side lookup, never from the request.** The org for a public complaint submission or QR scan comes from the `Location` row resolved by `locationId`/`qrCode`; the org for a review action comes from the `Ticket` row resolved by the full-value `reviewToken`. Neither ever reads a client-supplied `orgId`.
6. **Worker routes (`worker-auth.js`) layer location-coverage scoping on top of `orgId`.** A worker's `orgId` alone is not sufficient to authorize access to a ticket — `getWorkerCoverageLocationIds(workerId, orgId)` must also gate any ticket list/detail/pickup/resolve action, so a worker cannot act outside their assigned locations even within their own org.
7. **A route serving an org's own public-facing content (`pages.js`) must gate on `status !== 'ACTIVE'`, matching every authenticated entry point (`middleware/auth.js`, `auth.js`, `worker-auth.js`, `public.js`).** `[WP7]` found and fixed a `pages.js` inconsistency that gated only on `status === 'DELETED'`, leaving a `SUSPENDED` org's landing pages, PWA manifest, and service worker fully reachable — a suspended org must stop being reachable everywhere, not just where authentication happens to already enforce it. The one intentional exception is `superadmin.js`'s own org-management endpoints, which must be able to fetch/act on a `SUSPENDED` org (e.g. to reactivate it) and correctly check `status === 'DELETED'`-only for that reason.
8. **New tenant-owned routes ship with a regression test under `test/integration/tenant-isolation*.test.js`** proving a second org can neither see the new data in a list endpoint nor mutate it by id (expect `404`, not `403` — the API must not confirm another org's resource exists). Follow the fixture pattern in `test/helpers/db.js` rather than inventing a new one.
9. **The `X-Org-Id` mechanism is this platform's only impersonation-like capability — a SuperAdmin "entering" an org from the SuperAdmin dashboard (`public/js/app.js`'s `saHeaders()`/`selectedOrgId`) — and every request made under it must be auditable, reads included.** `[WP8]` found `registerSAuditHook` only logged non-`GET` requests, so a SuperAdmin browsing an org's dashboard — almost entirely `GET` traffic (tickets, workers, attendance, PII) — left no audit trail at all; it now logs every `X-Org-Id` request (`sa_org_context_read` / `sa_org_context_write`), and the write is `await`ed inside the `onResponse` hook rather than fire-and-forget, since an audit log dropping an entry silently is worse than a best-effort side effect like a notification. `[WP8]` also fixed `tickets.js` and `attendance.js` computing an action's own `actorType` as `role === 'ADMIN' ? 'admin' : 'supervisor'` — for a SuperAdmin acting via `X-Org-Id`, this silently mislabeled a privileged cross-tenant write as an ordinary supervisor's in the org's own audit trail, not just the central SA hook's. Because `sa_org_context_*` entries carry the real `orgId`, they surface automatically in the affected org's own `GET /api/audit-logs` — cross-tenant access by a SuperAdmin is visible to the org whose data was accessed, not only to the SuperAdmin's own audit viewer.
- **No new PII field may be stored unencrypted.** Route it through `lib/crypto.js`'s AES-256-GCM helpers if it is sensitive personal data (identity documents, health/biometric data, financial data). Encryption enforcement must **never** be conditioned on `NODE_ENV` — it must be enforced in every environment. *(Closes Audit finding [C5], Execution Plan [WP2].)*
- Any new secret or credential is added to `REQUIRED_ENV` in `src/config/env.js` (hard-fail at boot) or explicitly documented as optional with a safe, no-op fallback — no silently-optional required secrets.
- **A secret used for signing/verifying (JWTs, cookies, the admin bootstrap key) is validated for minimum length at startup, not just presence.** `[WP13]` found `JWT_SECRET`/`COOKIE_SECRET`/`ADMIN_KEY` were only checked for truthiness — a one-character value would have booted without complaint, silently making tokens/cookies forgeable. `src/config/env.js`'s `MIN_SECRET_LENGTH` map is the pattern to extend for any new signing secret.
- Until CSP hardening lands (`[M12/WP12]`), avoid adding new inline `<script>` blocks where a shared `app.js` function will do instead — don't make the eventual CSP migration harder.
- Any new file-upload path reuses the existing validation (magic-byte check, size/type limits) and the existing private R2 proxy pattern (`routes/images.js`) — no new publicly-addressable storage.
- Any new SuperAdmin-facing capability that can act cross-tenant must be covered by the audit-hook pattern (`registerSAuditHook`), including read access where the action exposes another org's data.
- **Self-service credential recovery follows the `resetToken`/`resetTokenExpiresAt` pattern established in `[WP14]`** (`User` and `Worker` models): a single-use, random 32-byte hex token with a 1-hour expiry, cleared in the same write that consumes it. Only the token's SHA-256 digest is stored (`hashResetToken` in `lib/security.js`); the e-mailed token is the credential, so a database read or a backup cannot be used to reset an account. The request side (`/auth/forgot-password`, `/auth/worker-forgot-pin`) always returns an identical, generic response regardless of whether the account exists — timing is normalized too (`antiEnumerationDelay()`), not just the response body. The completion side (`/auth/reset-password`, `/auth/worker-reset-pin`) sets `tokenInvalidBefore` (invalidating every session token issued before the reset) and reissues a fresh token in the same response, so the user is fully recovered without a separate login step. Any future credential-recovery flow (e.g. a third auth surface) should reuse this exact shape rather than inventing a new one.
- **A computed risk/abuse score must actually be enforced, not only recorded.** `[WP11]` found `public.js`'s spam `riskScore` (duplicate-submission detection on the one unauthenticated write surface) was computed and stored on every ticket but never acted on. It's now enforced (`429`) at the score's own top tier — the existing threshold, not a new one — checked as early as possible in the handler (before category validation, image upload, or ticket creation) so a rejected submission never does unnecessary work. Any future abuse-scoring addition should follow this same "compute early, enforce before doing real work" shape. The abuse-detection IP hash is now peppered (`IP_HASH_PEPPER`, HMAC-SHA256) with a safe unpeppered fallback when unset, matching the optional-secret pattern already used for `GLOBAL_AI_*`.

## 7. Performance Requirements

- New list/query endpoints ship with pagination and, if querying on a new field combination, a matching `orgId`-first composite index added via migration.
- No unbounded exports — follow the existing 5,000-row CSV cap convention (`electrical.js`, `assets.js`, `asset-failures.js`) unless a work package explicitly revisits it.
- Avoid N+1 query patterns; use Prisma `include`/`select` batching consistent with existing route style. Use `$queryRaw` for time-series aggregation as the codebase already does, rather than pulling full row sets into Node for in-memory aggregation.
- **Traversing a self-referencing hierarchy (`Location.parentId`) is a single recursive CTE (`WITH RECURSIVE ... $queryRaw`), never a loop of one query per level.** `[WP11]` found `services/assignment-resolver.js`'s ancestor/descendant/breadcrumb walks each doing up to `maxDepth` (10) sequential round trips per call — on the hottest paths in the app (`getWorkerCoverageLocationIds` runs on nearly every worker-app request; `getAssignedSupervisorIds`/`getAssignedWorkerIds` run on every ticket creation and public complaint). Rewritten as single-round-trip recursive CTEs; see `assignment-resolver.js` for the reference pattern. Any new hierarchy-walking code should follow it, not reintroduce the per-level loop.
- **Bulk notifications to a known set of recipients use a single `createMany`, never a loop of one `create` per recipient.** `notifyAdmins`/`notifyWorkers`/`notifySupervisorIds` (`services/notification-service.js`) are the reference pattern — `[WP11]` found one caller (`automation.js`'s `NOTIFY_ASSIGNED_SUPERVISORS` alert action) still looping one insert per supervisor and fixed it. `notifySupervisors` (no `Ids` suffix) is a different, intentionally separate function — it notifies *every* active supervisor in the org, not a specific list.
- Do not assume a job queue or shared cache exists. Every scheduled job today is an in-process `setInterval`, and there is no Redis in the stack — new scheduled work must fit that model unless Execution Plan `[WP6]` has changed it.

## 8. Database Safety

- **Every schema change goes through a Prisma migration.** No manual or out-of-band database edits, ever, in any environment.
- New tenant-owned tables include `orgId` with an org-first composite index, matching the existing schema-wide pattern.
- **Multi-step writes affecting more than one record must be wrapped in `$transaction`.** This applies without exception going forward, closing the inconsistency identified in Audit finding `[H5]` / Execution Plan `[WP9]` — "it's probably fine without one" is not an acceptable justification.
- No destructive migration (dropping a populated column or table) ships in a single deploy. Use an expand-migrate-contract sequence across separate deploys: add nullable → backfill → enforce → drop old, each independently deployable and revertible.
- Preserve the existing **soft-delete-first, hard-delete-gated** convention (`isActive: false` before permanent delete, permanent delete blocked while dependent records exist) for any new user-facing entity, unless a work package explicitly and deliberately changes that policy for a specific model.
- Every migration must have a stated rollback approach before it ships (§15).

### 8.1 What counts as a "multi-step write" requiring `$transaction`

`[WP9]` swept the ticket, asset, attendance, and inspection workflows for handlers that write more than one primary business record and found several genuine gaps (`assets.js` create/update/delete, `asset-events.js`, `asset-failures.js` report/resolve — all now wrapped) plus one non-transaction fix (`tickets.js`/`public.js` ticket auto-assignment, which used to `create()` then immediately `update()` the same row — now resolved before creation so it's a single write instead). The line to draw, going forward:

- **Two or more primary business entities that must describe the same reality** (e.g. `Asset.status` and its own `AssetEvent`/`AssetFailure` records) always need `$transaction` — a partial write here isn't cosmetic, it's the system disagreeing with itself about what happened.
- **A primary write plus its own `AuditLog` entry is *not* automatically required to be transactional**, matching this Charter's existing classification of audit-log writes as a non-critical secondary effect (§4). Several routes still write these as two separate calls (`tickets.js` resolve/verify/reopen, `worker-auth.js` resolve, `locations.js`, `supervisors.js`, `workers.js`, and others) — left as-is by `[WP9]`, not because it's ideal, but because it's the same low-severity pattern repeated across most of the codebase and a mechanical sweep of it was judged out of this work package's scope. Wrapping the audit-log write together with its primary write **when you're already touching that code for another reason** is free and welcome, just not a mandate to go rewrite working handlers solely for this.
- When in doubt, ask: "if the second write silently never happened, would any user-visible business fact become false?" If yes, `$transaction`. If the answer is only "the audit trail would be missing an entry," treat it like any other non-critical side effect.

### 8.2 State-transition and business-invariant consistency

`[WP10]` found that this codebase's lifecycle rules live in two places that can drift apart: a **dedicated action route** (e.g. `POST /tickets/:id/resolve`, `PATCH /asset-failures/:id`) that correctly enforces preconditions and keeps dependent state in sync, and a **generic admin editor** (`PATCH /tickets/:id`, `PATCH /assets/:id`) that lets an admin set the same field directly — but without the dedicated route's side effects or guardrails. Two concrete gaps were closed:

- **`tickets.js` `PATCH /tickets/:id`** could set `status: 'RESOLVED_PENDING_VERIFY'` directly, a state that's only supposed to mean "a worker just submitted resolution evidence, awaiting supervisor verification" — meaningless (and now rejected, `400`) coming from an admin edit with no evidence attached. It could also move a resolved/verified ticket back to an active status (`OPEN`/`IN_PROGRESS`/etc.) without clearing `resolvedAt`/`resolvedImageUrl`/`resolvedNote`/`verifiedAt`/`verifiedById`/`verifyNote`/`resolvedWorkers` — the dedicated `/reopen` endpoint already clears these; the generic PATCH now does too, whenever the new status is active-like and the ticket currently carries resolution/verification data. Moving to `CLOSED` is **not** treated as a reopen — a closed-and-resolved ticket keeps its resolution evidence.
- **`assets.js` `PATCH /assets/:id`** let an admin move a `FAULTY` asset straight to `OPERATIONAL`/`UNDER_MAINTENANCE` by hand while it still had open `AssetFailure` records — the asset's own status would then contradict its failure history. Now rejected (`409`) unless the failures are resolved first (via `PATCH /asset-failures/:id`, which already flips the asset back correctly) — except decommissioning, which is exempt since it makes open failures moot rather than contradicted.

**The general pattern for future work**: when a generic editor route (a catch-all admin PATCH) can set the same field a dedicated, side-effect-aware action route also sets, check whether the generic path can produce a state the dedicated path would never produce — a machine-only status with no evidence, or a status that contradicts a sibling record's own state. If so, either reject the transition outright or apply the same cleanup/derivation the dedicated route already does. This is deliberately narrow — it is not a mandate to build a formal state-machine validator across every field; only fields where a real user-visible contradiction was found and confirmed are in scope.

### 8.3 Resilience infrastructure must actually be wired in, not just built

`[WP12]` found `lib/circuit-breaker.js`'s two breakers (`dbBreaker`, `aiBreaker`) both already existed, were both already displayed on `/health`, and were both **largely decorative** — `dbBreaker` had no caller anywhere in the route/service layer at all (`dbExec()`, the only function that would have invoked it, was itself never called — since removed), and `aiBreaker` was wired only into `services/predictions.js`'s background anomaly-detection job, not `routes/ai.js`'s actual user-facing `/ai/chat` and `/ai/analyze` endpoints. This meant `/health`'s `circuitBreakers.database` field could never reflect reality (permanently `CLOSED, 0 failures` no matter how unhealthy the database actually was), and a real database or AI-provider outage would still queue up every request against a known-down dependency instead of fast-failing.

- **Every Prisma query is now routed through `dbBreaker` automatically**, via a Prisma Client Extension in `lib/prisma.js` (`rawPrismaClient.$extends({ query: { $allOperations... } })`) — this required no changes to any of the ~25 route files, since they all consume the shared `prisma` export. New route code doesn't need to do anything differently to get this protection. Note the scope: `$allOperations` covers per-model operations (`findMany`/`create`/`update`/...); it does **not** cover `$queryRaw`/`$transaction` as client-level methods themselves (each individual statement *inside* a `$transaction` callback is still covered, since `tx` inherits the same extension).
- **Both live AI provider call sites (`ai.js` `/ai/chat` and `/ai/analyze`) are now wrapped in `aiBreaker.exec(...)`**, matching the pattern `predictions.js` already used. When adding a new call to an external AI provider, wrap it the same way — check `lib/circuit-breaker.js`'s existing breakers before creating a new one.
- **When you build a circuit breaker, retry helper, or similar resilience primitive, grep for its actual call sites before considering it done.** A breaker that exists and reports a status but is never exercised by real traffic is worse than not having one, because it looks like monitoring that isn't actually monitoring anything.
- **`index.js` now handles `uncaughtException`, not just `unhandledRejection`.** A synchronous exception escaping every try/catch and Fastify's own request-lifecycle handling previously fell through to Node's raw default (print to stderr, exit) — skipping this app's own error log and alerting entirely. It now logs via the same `logError()` used elsewhere, then exits (per Node's own guidance: resuming after an uncaught exception is unsafe, since the process may be in an undefined state) — this is deliberately different from `unhandledRejection`'s existing behavior (log and keep running), which was left unchanged.
- **A resilience primitive wired into some callers is not the same as being wired into all of them.** `[WP10 — Automation & Alerting Reliability]` found that `[WP12]`'s `aiBreaker` wrapping above covered `ai.js`'s two live endpoints and `predictions.js`'s background job, but not `automation.js`'s own `generateDailyInsight` — a third, independently-duplicated AI-calling implementation that called providers directly with no breaker at all. The underlying problem was structural: `ai.js`, `automation.js`, and (indirectly, via a lazy require of `automation.js`) `predictions.js` each carried their own copy of credential resolution and the Azure/Gemini HTTP-calling logic, so breaker coverage depended on every copy remembering to wrap its own call. All three now share a single implementation, `lib/ai-provider.js`, whose `callAiProvider()` wraps `aiBreaker.exec(...)` internally — a caller cannot get this wrong, because there is no longer a per-caller choice to make. `automation.js` and `predictions.js` no longer duplicate the provider-calling functions; `automation.js` re-exports `resolveAiCredentials`/`callAiProvider` from the shared module for backward compatibility with existing consumers. `routes/superadmin.js`'s `/superadmin/ai/test-key` endpoint deliberately keeps its own minimal, unwrapped implementation — it validates a candidate key before it's saved, and routing key-validation traffic through the shared org-serving `aiBreaker` would let one org's bad test key degrade service for every other org.

### 8.4 Scheduled alerting must read an org's own configuration, not a hardcoded default

`[WP10 — Automation & Alerting Reliability]` found `automation.js`'s `checkMissedInspections` used a hardcoded `{ MORNING: 14, AFTERNOON: 22, NIGHT: 6 }` deadline table to decide when a shift's inspection should be considered missed, ignoring the per-org `ShiftConfig` rows that `routes/electrical.js` already read (via its own local closures) for the unrelated purpose of validating a submission's lateness. An org that had configured non-default shift windows got missed-inspection alerts timed for shifts it doesn't run. The shift-window logic (`getShiftConfigs`, `getExpectedShiftFromConfig`, `isWithinShiftWindowConfig`, `hasShiftStarted`) is now a single shared module, `services/shift-config.js`, extracted from `electrical.js` with no behavioral change, and `checkMissedInspections` now derives its per-shift deadline from that same org-scoped config — falling back to the same default windows as before when an org has no custom `ShiftConfig` rows. When two parts of the codebase need the same org-level configuration, extract it to `src/services/` (§5) rather than letting a second copy silently drift out of sync with the first.

## 9. API Compatibility

- No breaking change to an existing route's response shape, status codes, or auth requirements without a Release Notes entry and, for customer-visible routes, advance notice.
- New response fields are additive by default and safe to ship without a version bump. Removing or renaming an existing field requires a deprecation window, not an in-place change.
- Preserve existing auth transport conventions (`Authorization: Bearer`, `X-Org-Id` for SuperAdmin org-switch). Do not introduce a second, competing auth transport (e.g. a new cookie-based session) without an ADR.
- Versionless `/api` routes remain versionless unless a work package explicitly introduces versioning — don't introduce ad hoc `/v2/` routes as a one-off.

## 10. UI/UX Consistency

- Reuse the shared UI kit in `public/js/app.js` (toasts, modals, `confirmDialog`, skeleton loaders, the notification bell, `custom-select.js`) — no bespoke, one-off UI patterns on a single page when a shared function already exists.
- Use the existing design-system tokens (`public/css/design-system.css`) for color, radius, and shadow — no new hardcoded values outside the token system.
- Preserve the existing theme convention: field-worker pages (electrician, supervisor) default to dark; admin/superadmin pages default to light. Any change to this convention is a deliberate UX decision, not a per-page choice.
- Any new page follows the existing `/{orgSlug}/{module}/{page}` routing convention and is registered in `routes/pages.js`'s page list — pages do not get ad hoc URLs outside this scheme.
- Preserve existing empty-state, loading-state (skeleton), and per-section error-isolation patterns already established across admin dashboards.

## 11. Accessibility

- Every new interactive element ships with correct semantic markup, `alt` text on meaningful images, and keyboard operability **from the start** — accessibility is not a deferred pass. This codebase already has an accessibility remediation debt (`[H7]` / `[WP13]`); new work must not add to it.
- Once the automated accessibility scan from `[WP13]` exists in CI, no new or modified page merges with a critical/serious violation.
- Focus states must remain visible; do not suppress `:focus-visible` styling for aesthetic reasons.

## 12. Testing Requirements

- Once the test foundation (`[WP1]`) exists, **no change merges without a corresponding automated test** for the specific behavior added or fixed. Tests are written alongside the change, not deferred to "a follow-up."
- Minimum bar for a bug fix: a test that fails without the fix and passes with it, committed in the same change.
- Security-sensitive changes (auth, tenant-scoping, encryption, impersonation) require both an automated test and an explicit manual verification step, documented in the implementation summary.
- Until `[WP1]` exists, every change requires a documented manual test procedure in its implementation summary, sufficient for another engineer to reproduce the verification without guessing.

## 13. Regression Verification

- The full automated suite (once it exists) must pass before merge, with no skipped or newly-`.only`'d tests left behind.
- Manually verify the functionality *adjacent to* the change, not only the change itself — if `tickets.js` is touched, check the ticket list, detail, and at least one other lifecycle action, not only the one endpoint edited.
- For changes touching a **shared file** (`app.js`, `tickets.js`, `auth.js`, `notification-service.js`, `design-system.css`), regression-check every role/page that depends on that file, not only the one that motivated the change — shared files have the widest blast radius in this codebase.

## 14. Deployment Readiness

- Every change states, before merge, whether it requires: a database migration, a new/changed environment variable, a process restart, or a scheduler-timing consideration (e.g. a change near the daily AI-insight generation window).
- No change may assume a manual production step beyond what the standard deploy pipeline performs. Anything requiring manual intervention must be written up as an explicit deployment note and, ideally, converted into an automated step.
- Once `[WP4]` (CI/CD hardening and staging) lands, **every change passes through staging before production, without exception** — including hotfixes, which get an expedited but not skipped staging pass.
- **`NODE_ENV` must be exactly `production` in every real deployment path** (`docker-compose.yml`, both GitHub Actions workflows already do this) — it silently controls both query-log verbosity (`lib/prisma.js`) and CORS restriction (`plugins/security.js`). `[WP13]` added a startup warning (not a hard failure, to preserve the existing unset-means-local-dev convention) when `NODE_ENV` is set to something other than `production`/`development`/`test`, to catch a typo before it silently ships permissive defaults.

## 15. Rollback Planning

- Every change states its rollback method before merge: a plain revert, a feature-flag disable, or migration-specific rollback steps (per the expand-contract pattern in §8).
- Destructive or hard-to-reverse changes (data-dropping migrations, credential rotation, third-party integration swaps) require a **tested rollback dry run**, not just a written plan — "we could revert this" is not sufficient for anything in this category.
- Prefer a feature-flaggable rollout for anything touching authentication, tenant-scoping, or ticket/asset status-transition enforcement, so a bad rollout can be disabled instantly without a full code revert (matches the Execution Plan's guidance for `[WP7]`/`[WP9]`).

## 16. Documentation Updates

See the Documentation Policy trigger table in **§22** — run it for every change before merge. The short version: if a change is invisible to every audience (code readers, operators, users, admins), no documentation update is required, and the plan must say so explicitly rather than silently skipping it.

## 17. Artifact Updates

"Related artifacts" beyond prose documentation include: `.env.example` (any new/changed/removed environment variable), infrastructure config (`docker-compose.yml`, `Caddyfile`, GitHub Actions workflows) if topology or process changes, and **this Charter itself**.

- Any change to a rule in this Charter is a dated, explicit amendment (§23) — never a silent edit. The Charter's own history is part of the project's institutional memory.

## 18. Release Notes

- Every customer-visible behavior change gets a Release Notes entry, written in the language the affected user would recognize ("Public complaint submissions are now limited to prevent spam" — not "added riskScore enforcement to POST /public/complaint").
- Internal-only refactors, dependency bumps, and test/tooling changes do not require Release Notes, but do require a `CHANGELOG.md` entry (see the repository root `CHANGELOG.md`, established by `[WP16]`).
- Security fixes are described in Release Notes without disclosing exploit details — state the user-facing improvement, not the vulnerability mechanics.

## 19. Definition of Done

A work package is not complete until every item below is true — this extends the Execution Plan's shared template with explicit Charter compliance:

- [ ] Code changes are complete and merged
- [ ] Manual testing is complete against the change's stated acceptance criteria
- [ ] Automated tests are included (once `[WP1]` exists) and the full suite passes
- [ ] Regression testing is complete, including adjacent functionality and shared-file blast radius (§13)
- [ ] Documentation is updated per the §22 trigger table (or explicitly marked not required)
- [ ] Related artifacts are updated (§17)
- [ ] Deployment notes are written (§14)
- [ ] Rollback instructions are written and, where required by §15, verified by a dry run
- [ ] Acceptance criteria specific to this change are explicitly checked off, not inferred
- [ ] **This Charter's relevant sections were followed, and any deliberate deviation is explicitly noted and justified in the implementation summary**

## 20. Code Review Checklist

A concrete, scannable pass before merge (self-review is acceptable given current team size, but must still be performed explicitly, not implicitly):

- [ ] Does every new/changed query against a tenant-owned model include an org-scope filter?
- [ ] Does every new/changed route pass through the correct auth + policy + module gate?
- [ ] Are multi-step writes wrapped in `$transaction`?
- [ ] Is any new PII field encrypted, with enforcement independent of `NODE_ENV`?
- [ ] Are there unrelated changes (reformatting, renames, opportunistic refactors) bundled into this change? If yes, split them out.
- [ ] Does the change match the file's existing conventions (route-per-resource, fire-and-forget side effects, shared UI kit, design tokens)?
- [ ] Is there a test proving the fix/feature, and does the existing suite still pass?
- [ ] Is the rollback method stated and, if required, verified?
- [ ] Is the Documentation Policy table (§22) satisfied?
- [ ] Does the implementation summary state the root cause (§2), not just the symptom fixed?

---

## 21. Mandatory Implementation Workflow

Every future work package — no exceptions — follows this sequence:

1. **Understand the request.** Restate it in your own words, including what's explicitly out of scope, before touching any file.
2. **Inspect relevant files.** Re-derive current behavior from the live repository (§1) — do not rely on memory of a prior discovery pass.
3. **Confirm root cause.** Apply §2. State it explicitly before proposing a fix.
4. **Analyze impact.** Identify every file, route, shared component, and downstream consumer the change touches, including the "shared-file blast radius" from §13.
5. **Present implementation strategy.** Use Plan Mode for anything beyond a trivial one-line fix; get explicit approval before code changes begin. State the smallest safe change (§3).
6. **Implement the smallest safe change.** No opportunistic scope creep (§3, §4).
7. **Verify functionality.** Manual verification against the stated acceptance criteria, minimum.
8. **Run regression tests.** Full suite (once it exists) plus the adjacent/shared-file manual checks from §13.
9. **Update documentation and artifacts.** Run the §22 table; update `.env.example`/infra config/this Charter as applicable (§17).
10. **Produce an implementation summary.** Root cause, what changed, why, what was explicitly deferred, rollback method, and a link back to the relevant Audit/Execution-Plan finding IDs.
11. **Confirm Definition of Done.** Walk the §19 checklist explicitly — do not mark a work package complete by assumption.

---

## 22. Documentation Policy — Trigger Table

Run this table for **every** change. If an artifact's trigger condition isn't met, state explicitly that no update is required — don't skip the row silently. The **canonical file** column names where each lives; [`docs/README.md`](README.md) is the index that maps the whole knowledge base.

| Artifact | Canonical file(s) | Update required when… |
|---|---|---|
| **README** | [`README.md`](../README.md), [`apps/api/README.md`](../apps/api/README.md) | Setup, run, test, or deploy instructions change, or a new top-level capability is added. |
| **CHANGELOG** | [`CHANGELOG.md`](../CHANGELOG.md) (established by `[WP16]`) | Every merged change gets an entry, without exception. |
| **Release Notes** | [`docs/releases/`](releases/) (the first, `v1.0.0-draft.md`, is drafted; published with the first tagged release) | The change is visible to a guest, electrician, supervisor, admin, or superadmin — a new capability, a behavior change, or a customer-noticeable bug fix. |
| **Architecture Documentation** | [`docs/architecture/`](architecture/) | A new pattern, service, external integration, or structural relationship is introduced, or an existing one materially changes (e.g. a new module, a topology change, a new shared-state mechanism). |
| **API Documentation** | [`docs/reference/routes.generated.md`](reference/routes.generated.md) — **generated** | A route is added or removed. Do not hand-edit: regenerate with `node scripts/gen-route-index.js` (or `npm run docs:routes`) from `apps/api/`. |
| **Database Documentation** | `apps/api/prisma/schema.prisma` (canonical), [`docs/architecture/data-model.md`](architecture/data-model.md) (relationships/lifecycles) | Any schema/migration change — new model, field, relationship, index, or constraint. |
| **Module Documentation** | [`docs/architecture/module-system.md`](architecture/module-system.md) | A business module's (`ele`/`civil`/`asset`/`complaints`) workflow, configuration, or dependency behavior changes. |
| **Deployment Documentation** | [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | The deploy process, infrastructure topology, required manual steps, or environment count/config changes. |
| **Operations Documentation** | [`docs/MONITORING.md`](MONITORING.md), [`docs/RUNBOOKS.md`](RUNBOOKS.md), [`docs/DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md), [`docs/SCALING.md`](SCALING.md) | A health/alerting/logging signal, a new failure mode + response, backup/restore, or scaling guidance changes. |
| **Environment Variable Documentation** | [`.env.example`](../.env.example) (values), [`docs/reference/environment.md`](reference/environment.md) (semantics) | Any env var is added, removed, renamed, or its enforcement rule changes (required vs. optional, which environments enforce it). |
| **User Documentation** | (external) | An end-user-facing (guest/electrician/supervisor/admin) workflow or UI element changes in a way a user would notice. |
| **Admin Documentation** | (external) | An admin- or superadmin-facing capability, permission, or configuration option changes. |
| **Storylane / Demo Artifacts** | (external) | The change would make an existing demo/onboarding walkthrough show outdated, broken, or misleading behavior. |
| **ADR** | [`docs/adr/`](adr/) | The change makes an architecturally significant, hard-to-reverse decision — a new dependency, a deviation from an established pattern (§5), or a change to the security model (§6). Routine feature work does not need an ADR. |

---

## 23. Amendment Process

This Charter is permanent in the sense that it always governs — it is not permanent in the sense of being frozen. It changes only deliberately:

1. A proposed amendment is written as a dated entry below, stating what changed and why (e.g. "a new pattern was adopted and needs a rule," "a rule proved impractical in practice").
2. The amendment is reviewed and approved the same way any architecturally significant decision is (§5, §17) — not folded silently into an unrelated code change.
3. The Charter's version history below is the record of its own evolution.

### Amendment Log

| Date | Change | Reason |
|---|---|---|
| 2026-07-12 | Charter created | Establishes the Definition of Engineering for this project, following the Production Readiness Audit and Engineering Execution Plan. |
| 2026-07-19 | Added §6.1, the Tenant-Scoping Contract | `[WP7]` closed Audit finding `[H1]` with an exhaustive manual sweep of every route file plus new regression tests; this formalizes what that sweep verified as a durable written rule rather than a one-time result. |
| 2026-07-19 | Added §6.1 item 9, the SuperAdmin impersonation audit rule | `[WP8]` found the existing audit-hook rule (§6's last bullet, already on the books) wasn't actually met by `registerSAuditHook` — reads via `X-Org-Id` weren't logged at all, and two routes mislabeled a SuperAdmin's write as a supervisor's. This records what was fixed and why, so the gap between the stated rule and the code doesn't reopen silently. |
| 2026-07-19 | Added §8.1, what counts as a "multi-step write" | `[WP9]` closed Audit finding `[H5]` by wrapping the asset/failure/event workflows in `$transaction` and eliminating a create-then-update double-write in ticket auto-assignment. This draws the line the §8 rule needed but didn't state: primary-entity consistency is mandatory, primary-write-plus-audit-log is not (matches §4's existing non-critical-side-effect classification) — so future work doesn't over- or under-apply the rule. |
| 2026-07-19 | Added §8.2, state-transition and business-invariant consistency | `[WP10]` found generic admin PATCH routes (`tickets.js`, `assets.js`) could set fields into states their own dedicated action routes would never produce — a machine-only ticket status with no evidence, an asset marked healthy while its own failure records say otherwise. Records the general pattern (check for generic-vs-dedicated-route drift) so it's checked deliberately in future work, not rediscovered per field. |
| 2026-07-19 | Extended §7 with the recursive-CTE and batched-notification rules | `[WP11]` found `assignment-resolver.js`'s location hierarchy walks and one alert-notification path doing one DB round trip per item instead of one round trip total — on some of the hottest paths in the app. Records both fixed patterns as the standard going forward. |
| 2026-07-20 | Added §8.3, resilience infrastructure must actually be wired in | `[WP12]` found both circuit breakers (`dbBreaker`, `aiBreaker`) were built, tested nowhere, and mostly unused by real traffic despite being reported on `/health` — fixed via a Prisma Client Extension (all DB calls) and wrapping both live AI endpoints. Also added the missing `uncaughtException` process handler alongside the existing `unhandledRejection` one. Records the general lesson: verify a resilience primitive's actual call sites, not just its existence. |
| 2026-07-20 | Extended §6 and §14 with secret-strength and `NODE_ENV` validation rules | `[WP13]` (final production-readiness pass) found `JWT_SECRET`/`COOKIE_SECRET`/`ADMIN_KEY` were only checked for presence, not strength, and that no startup check would catch a typo'd `NODE_ENV` silently disabling production-safe defaults. Both are now validated at boot; records the patterns for any future secret or environment-mode config. |
| 2026-07-21 | Added §6 self-service credential recovery rule | `[WP14]` introduced self-service password reset (`User`) and PIN reset (`Worker`), plus fixed worker PIN-change forcing an unnecessary re-login. Records the `resetToken`/`resetTokenExpiresAt` pattern (single-use, time-limited, anti-enumeration on both response body and timing) as the shape any future credential-recovery flow should reuse. |
| 2026-07-21 | Added §6 risk-score enforcement rule | `[WP11]` (the plan's original Public Complaint Abuse Prevention — executed after a roadmap reconciliation found it had been skipped) found the spam `riskScore` on public complaints was computed but never enforced, and the abuse-detection IP hash was unpeppered. Both closed; records "enforce, don't just record" and "check early, before real work happens" as the general lesson. |
| 2026-07-21 | Extended §8.3 and added §8.4 | `[WP10 — Automation & Alerting Reliability]` (the plan's original Automation & Alerting Reliability — executed after the final roadmap audit confirmed it, not the earlier same-numbered ticket/asset state-consistency work recorded at §8.2, was still outstanding) consolidated three duplicated AI-provider-calling implementations (`ai.js`, `automation.js`, and, indirectly, `predictions.js`) into one shared `lib/ai-provider.js`, closing the gap where `automation.js`'s daily AI insight generation ran with no circuit-breaker protection at all. Also extracted `electrical.js`'s local shift-window closures into a shared `services/shift-config.js` and fixed `automation.js`'s missed-inspection alerting to read each org's configured `ShiftConfig` instead of a hardcoded deadline table. |
| 2026-07-21 | Extended §5 with the unified notify() rule | `[WP15 — Notification Channel Unification]` replaced the independently-paired notification+email calls in `tickets.js` and `public.js` with a single `notify()` entry point in `services/notification-service.js`, dispatching to an audience via `NOTIFY_CHANNELS` and sending an optional paired email through the existing `lib/email.js` helpers. Records the pattern so future notification+email pairings (and future channels) extend this one interface instead of adding another independent pair of calls. |
| 2026-07-21 | Resolved the two "once `[WP16]` establishes it" forward-references in §18 and §22 | `[WP16 — Documentation & Release Process Hygiene]` created the repository-root `CHANGELOG.md` and `README.md`. §18 and §22's CHANGELOG rows previously deferred to a not-yet-created file; both now point at it directly. Also corrected a garbled comment in `apps/api/index.js` describing the image-cleanup scheduler's timer-capture fix. |
| 2026-07-21 | Made §22's trigger table concrete with a canonical-file column | The engineering knowledge base was built out (`docs/README.md` index, `docs/architecture/`, `docs/reference/`, `docs/MONITORING.md`/`RUNBOOKS.md`, an ADR framework with foundational ADRs 0002–0004, and `CLAUDE.md`). §22 previously named doc *types* but not the files that now exist; it now maps each artifact to its canonical location so the trigger table is directly actionable, adds an Operations row, and records that the route index is generated (regenerate, never hand-edit). Documentation/governance only — no application behavior changed. |
| 2026-10-13 | Recorded a deviation from §10's page-URL rule (`/{orgSlug}/{module}/{page}`): `/reset-password` and `/worker-reset-pin` are top-level pages | `[F12]`/BUG-0007: the reset emails already sent link to these exact URLs, and the pages serve people with no org context yet (like `/superadmin-login`). Both names are in `NON_ORG_PREFIXES` (`public/js/app.js`) and are routed in `routes/pages.js`. No other page may use a top-level URL without its own entry here. |
| 2026-10-13 | §8.3 clarified in `docs/architecture/resilience.md`: only infrastructure errors count toward the database breaker | `[F15]`/BUG-0008: counting every Prisma error let one request type (an electrician's photo loads) open the shared breaker and take the whole platform to 503. |
| 2026-10-25 | §6 credential-recovery rule: reset tokens are stored as their SHA-256 digest | BUG-0034 / PAR-10/21: the raw token was stored, so anyone who could read the database or a backup could reset any staff password or electrician PIN with a pending request. The e-mailed token stays the credential; a fast hash suffices for a 256-bit random value. Tokens issued before the change stop working (they expire within an hour anyway). |

---

*This Charter was produced as a planning and governance artifact. No application source files were modified to create it.*
