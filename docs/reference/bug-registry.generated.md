# Bug Scenario Registry (generated)

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with:  npm run docs:bugs   (from apps/api/)
     Source of truth: apps/api/scenarios/bugs/ -->

Every fixed production/engineering defect encoded as a reproducible scenario with a
regression test (platform milestone M4, see the Developer Platform Specification §6). Each
bug reuses the M3 scenario system to build its triggering state and asserts the fixed
behavior via the real app. Adding a bug: drop a module in `apps/api/scenarios/bugs/` and
register it — see an existing bug for the shape.

Commands: `npm run bug:list` · `npm run bug:run -- <ID>` · `npm run bug:validate` · `npm run bug:test`.

## Registry

| ID | Severity | Status | Module | Title | Regression test |
|---|---|---|---|---|---|
| BUG-0001 | HIGH | FIXED | ele | Admin could set a ticket to RESOLVED_PENDING_VERIFY directly | `test/integration/bug-regressions.test.js` |
| BUG-0002 | MEDIUM | FIXED | ele | Permanent-deleting a worker silently dropped their inspection history | `test/integration/bug-regressions.test.js` |
| BUG-0003 | HIGH | FIXED | complaints | Public-complaint spam risk score was computed but never enforced | `test/integration/bug-regressions.test.js` |
| BUG-0004 | MEDIUM | FIXED | complaints | A supervisor assigned to a location got two notifications per public complaint | `test/integration/bug-regressions.test.js` |
| BUG-0005 | HIGH | FIXED | ele | A worker could be created without an employeeId and then never log in | `test/integration/bug-regressions.test.js` |
| BUG-0006 | CRITICAL | FIXED | ele | Body-less POST/PATCH from the browser was rejected (electricians could not pick up tickets) | `test/integration/bug-regressions.test.js` |
| BUG-0007 | HIGH | FIXED | ele | Password and PIN reset links from email opened no page ("Organization not found") | `test/integration/bug-regressions.test.js` |
| BUG-0008 | CRITICAL | FIXED | ele | Electrician photo loads opened the database circuit breaker (whole platform 503 for 30 s) | `test/integration/bug-regressions.test.js` |

Count: 8 bug scenario(s).

## BUG-0001 — Admin could set a ticket to RESOLVED_PENDING_VERIFY directly

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Engineering audit — state-transition consistency ([WP10], Charter §8.2)
- **Introduced:** pre-audit · **Fixed:** 2026-07-19
- **Description:** The generic admin ticket editor accepted a worker-only status, producing a "pending verification" ticket with no resolution evidence.
- **Root cause:** PATCH /tickets/:id accepted any EDITABLE status, including RESOLVED_PENDING_VERIFY — a machine-only state that should only be produced by a worker submitting resolution evidence.
- **Expected behavior:** PATCH /tickets/:id with status=RESOLVED_PENDING_VERIFY is rejected with 400.
- **Broken behavior:** The PATCH succeeded (200) and moved the ticket into pending-verification with no evidence attached.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with an admin and an OPEN ticket.
2. As the admin, PATCH the ticket with { status: "RESOLVED_PENDING_VERIFY" }.
3. Broken: 200 and status changes. Fixed: 400 (rejected).

## BUG-0002 — Permanent-deleting a worker silently dropped their inspection history

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** worker-workflow
- **Origin:** Technical-debt cleanup — delete-guard parity ([WP17], finding L4)
- **Introduced:** pre-audit · **Fixed:** 2026-07-21
- **Description:** DELETE /workers/:id/permanent disconnected a worker from their inspection records and deleted, instead of blocking like the supervisor equivalent.
- **Root cause:** The worker permanent-delete route disconnected inspection links then deleted; the supervisor route blocked with 409. The two structurally-equivalent actions behaved differently, losing worker↔inspection history with no warning.
- **Expected behavior:** DELETE /workers/:id/permanent on a deactivated worker with inspection history is rejected with 409, preserving the association.
- **Broken behavior:** The worker was deleted and its inspection associations silently removed.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with an admin, a supervisor, and a deactivated worker linked to an inspection.
2. As the admin, DELETE /api/workers/:id/permanent.
3. Broken: 200 and the worker is deleted. Fixed: 409 and the worker remains.

## BUG-0003 — Public-complaint spam risk score was computed but never enforced

- **Severity:** HIGH · **Status:** FIXED · **Module:** complaints · **Category:** public-complaint
- **Origin:** Public Complaint Abuse Prevention ([WP11], audit finding H8)
- **Introduced:** pre-audit · **Fixed:** 2026-07-21
- **Description:** The abuse risk score on public complaints was recorded on the ticket but never acted on, so a spammer could file unlimited near-duplicate complaints.
- **Root cause:** POST /public/complaint computed a duplicate-submission riskScore and stored it, but no code rejected high-risk submissions.
- **Expected behavior:** A 4th rapid complaint from the same IP for the same location (risk score at its top tier) is rejected with 429.
- **Broken behavior:** Every submission succeeded (200) regardless of the risk score.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with a location.
2. Submit 3 public complaints from the same IP for the same location (all 200).
3. Submit a 4th from the same IP+location.
4. Broken: 200. Fixed: 429 (rejected).

## BUG-0004 — A supervisor assigned to a location got two notifications per public complaint

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** notification
- **Origin:** QA-1 characterisation finding F3 (docs/testing/COVERAGE_MATRIX.md), fixed in [WP-H]
- **Introduced:** pre-audit · **Fixed:** 2026-10-13
- **Description:** On a public complaint, the location's assigned supervisors received the direct "assigned" notification and also the org-wide supervisor broadcast for the same ticket.
- **Root cause:** POST /public/complaint called createNotification for each assigned supervisor and then notifySupervisors, which notifies every active supervisor in the org — including the assigned ones.
- **Expected behavior:** An assigned supervisor gets exactly one notification for the complaint (the direct one); every other supervisor in the org gets the broadcast once.
- **Broken behavior:** The assigned supervisor got two notifications for the same ticket.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with a location, a supervisor assigned to it, and an unassigned supervisor.
2. Submit a public complaint for the location.
3. Broken: the assigned supervisor has 2 notifications for the ticket. Fixed: exactly 1; the unassigned supervisor has 1.

## BUG-0005 — A worker could be created without an employeeId and then never log in

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** worker-workflow
- **Origin:** QA-1 characterisation finding F8 (docs/testing/COVERAGE_MATRIX.md), fixed in [WP-H]
- **Introduced:** pre-audit · **Fixed:** 2026-10-13
- **Description:** POST /api/workers accepted a worker with no employeeId, but worker-login identifies workers by employeeId + PIN — so that worker could never sign in. PATCH could also clear an existing employeeId.
- **Root cause:** employeeId was optional in the create schemas (workers.js, superadmin.js) and clearable in the PATCH schemas, while POST /auth/worker-login requires it.
- **Expected behavior:** Creating a worker without a non-empty employeeId is rejected with 400; a worker created with one can have a PIN set and log in.
- **Broken behavior:** The worker was created (200) with employeeId null and could not log in.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with an admin.
2. As the admin, POST /api/workers with a name and no employeeId.
3. Broken: 200 and a worker who can never log in. Fixed: 400.

## BUG-0006 — Body-less POST/PATCH from the browser was rejected (electricians could not pick up tickets)

- **Severity:** CRITICAL · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Batch 2 e2e journey J4 (finding F14), fixed in C9
- **Introduced:** pre-audit · **Fixed:** 2026-10-13
- **Description:** The browser helpers send Content-Type: application/json even with no body; the server rejected every such POST/PATCH with 400 FST_ERR_CTP_EMPTY_JSON_BODY before auth — breaking electrician Pick Up, alert acknowledge, AI insight generate, template duplicate, notification mark-read and the production-checks button.
- **Root cause:** public/js/app.js apiFetch/saFetch/elecFetch always set Content-Type: application/json, and Fastify's default JSON parser rejects an empty body. API tests used inject() without a content type, so they never saw it.
- **Expected behavior:** POST /api/worker/tickets/:id/pickup with Content-Type: application/json and an empty body succeeds (200) and moves the ticket to IN_PROGRESS.
- **Broken behavior:** 400 FST_ERR_CTP_EMPTY_JSON_BODY; the ticket stayed OPEN.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with a location, an electrician assigned to it, and an OPEN ticket there.
2. As the electrician, POST /api/worker/tickets/:id/pickup with Content-Type: application/json and no body — exactly what the electrician app sends.
3. Broken: 400 FST_ERR_CTP_EMPTY_JSON_BODY. Fixed: 200, status IN_PROGRESS.

## BUG-0007 — Password and PIN reset links from email opened no page ("Organization not found")

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** account-recovery
- **Origin:** Batch 1 characterisation (finding F12), fixed in C10
- **Introduced:** 2026-07-21 · **Fixed:** 2026-10-13
- **Description:** The reset emails link to /reset-password?token=… and /worker-reset-pin?token=…, but no such pages existed; both URLs fell through to the /:orgSlug page route, which answered "Organization not found". Users could not reset from the email.
- **Root cause:** WP14 added the reset APIs and the emailed links (auth.js, worker-auth.js) but no pages for the links to open; pages.js had no route for either path, so /:orgSlug matched them.
- **Expected behavior:** GET /reset-password?token=… and GET /worker-reset-pin?token=… serve the reset pages (200, HTML).
- **Broken behavior:** 404 {"error":"Organization not found"} (via the /:orgSlug route).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Request a password or PIN reset; open the emailed link.
2. Broken: "Organization not found". Fixed: the reset page with a new-password / new-PIN form.

## BUG-0008 — Electrician photo loads opened the database circuit breaker (whole platform 503 for 30 s)

- **Severity:** CRITICAL · **Status:** FIXED · **Module:** ele · **Category:** resilience
- **Origin:** Batch 2 e2e journey J7 (finding F15), fixed in C12
- **Introduced:** WP12 (dbBreaker wired into every Prisma operation) · **Fixed:** 2026-10-13
- **Description:** The electrician queue loads ticket photos through /api/images with the worker token. The route looked the token up as a staff user (id: undefined), Prisma threw a validation error, and the database circuit breaker counted it as a database failure. Five such loads within 60 s opened the breaker: every request from every user got 503 for 30 s. Electricians never saw the photos either (401).
- **Root cause:** dbBreaker counted every error thrown by a Prisma operation, including request-level validation errors; images.js and middleware/auth.js queried user.findUnique({ id: decoded.userId }) for worker tokens, which carry workerId, not userId.
- **Expected behavior:** Worker image loads are served (own org) and never count as database failures; an unrelated request right after them succeeds.
- **Broken behavior:** 401 for each photo, and after five of them the next unrelated request answered 503 "Service temporarily unavailable".
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Sign in as an electrician and GET /api/images/uploads/<orgId>/<file>?token=<worker token> five times.
2. Make any unrelated request, e.g. an admin listing locations.
3. Broken: 503 (database breaker OPEN). Fixed: 200, breaker CLOSED.

