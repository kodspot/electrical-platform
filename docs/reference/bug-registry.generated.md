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
| BUG-0009 | MEDIUM | FIXED | ele | Permanently deleting a supervisor who created tickets failed with a server error | `test/integration/bug-regressions.test.js` |
| BUG-0010 | HIGH | FIXED | ele | Electrician and supervisor nav links were double-prefixed (/{org}/{mod}/{org}/{mod}/{page} → 404) | `test/integration/bug-regressions.test.js; e2e/tests/journeys.spec.js › "electrician nav links work after module sync (BUG-0010)" and "supervisor nav links work after module sync (BUG-0010)"` |
| BUG-0011 | HIGH | FIXED | ele | A role nav link hidden until the module sync came back double-prefixed (supervisor Assets → 404) | `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › "supervisor › supervisor-assets" and "supervisor › supervisor-electrical"` |
| BUG-0012 | MEDIUM | FIXED | ele | Admin analytics showed "undefined" for inspection records, flagged records and the location breakdown | `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › rawValue check (admin › admin-analytics)` |
| BUG-0013 | MEDIUM | FIXED | ele | Four admin pages had no working admin nav (assets, electrical, failures: run-together links and a too-wide page on phones; predictions: none at all) | `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › nav and overflow checks (admin pages)` |
| BUG-0014 | LOW | FIXED | ele | The admin Alerts page was always dark, unlike every other admin page | `test/integration/bug-regressions.test.js; e2e visual baseline admin-alerts` |
| BUG-0015 | HIGH | FIXED | ele | An electrician could "resolve" a ticket that a supervisor had already verified, sending it back to verification | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0016 | HIGH | FIXED | complaints | A reopened public ticket could still be closed by the guest's old review link, or by the review auto-close | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0017 | MEDIUM | FIXED | complaints | After a guest rejected a fix, the next verified fix never got a guest review | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0018 | MEDIUM | FIXED | ele | The electrician was never told that their fix was verified, or that it was sent back and why | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0019 | HIGH | FIXED | ele | Alert escalations never reached the supervisors or electricians of the location, nor raised their ticket | `test/integration/alert-escalation.test.js` |
| BUG-0020 | MEDIUM | FIXED | complaints | A guest complaint could be filed under a module the organization had not enabled | `test/integration/authz-sweep.test.js` |
| BUG-0021 | MEDIUM | FIXED | asset | Clearing an optional field in the asset, location or alert-rule edit form was not saved | `e2e/tests/forms.spec.js` |
| BUG-0022 | LOW | FIXED | ele | On a phone that cannot scan QR codes (iPhone Safari), "Open Camera" switched the camera on with nothing reading it | `e2e/tests/forms.spec.js` |
| BUG-0023 | HIGH | FIXED | ele | A super-admin could not create an organization without entering an email | `test/integration/superadmin-org-form.test.js` |
| BUG-0024 | MEDIUM | FIXED | asset | After logging an asset event or reporting a failure, the supervisor saw a blank page | `e2e/tests/forms.spec.js` |
| BUG-0025 | MEDIUM | FIXED | ele | A new duty roster suggested no electrician when they covered the floor from its building | `test/integration/admin-forms-api.test.js` |
| BUG-0026 | MEDIUM | FIXED | complaints | After a guest rejected a fix, the electrician who did it saw the ticket as "Done" and could not pick it up again | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0027 | CRITICAL | FIXED | ele | The electrician API returned the guest's review token, name, phone, IP hash and user agent | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0028 | CRITICAL | FIXED | ele | Stored XSS: an org admin could plant script in names that ran for anyone opening the page, including a super-admin | `test/public-escaping.test.js` |
| BUG-0029 | HIGH | FIXED | ele | `npm test` passed when a test file's describe() threw while collecting its tests | `test/report-tests.test.js` |
| BUG-0030 | CRITICAL | FIXED | ele | Supervisors' Aadhaar numbers and blood groups were stored in plain text and copied into audit logs | `test/integration/supervisor-pii.test.js` |
| BUG-0031 | HIGH | FIXED | ele | Worker detail, create and update responses carried the PIN hash and a pending PIN-reset token | `test/integration/worker-credentials.test.js` |
| BUG-0032 | HIGH | FIXED | ele | An org admin's "run escalations" escalated every tenant's alerts, outside the scheduler lock | `test/integration/alert-manual-checks.test.js` |
| BUG-0033 | HIGH | FIXED | ele | A proof photo uploaded late in an old ticket's life was deleted the next night | `test/integration/image-cleanup.test.js` |
| BUG-0034 | HIGH | FIXED | ele | Password and PIN reset tokens were stored as issued, so the database value itself reset the account | `test/integration/account-recovery.test.js` |
| BUG-0035 | MEDIUM | FIXED | ele | Permanently deleting an electrician who was on a duty roster failed with a 500; attendance history was silently erased | `test/integration/permanent-delete-parity.test.js` |
| BUG-0036 | HIGH | FIXED | ele | `npm test` passed when a suite's after() hook threw — e.g. a cleanup that left test data behind | `test/report-tests.test.js` |
| BUG-0037 | HIGH | FIXED | ele | A deactivated (or moved) supervisor kept their open tickets, where no one else could see them | `test/integration/supervisor-handover.test.js` |
| BUG-0038 | HIGH | FIXED | ele | Two people acting on one ticket at once both "succeeded" — the last write won | `test/integration/ticket-concurrency.test.js` |
| BUG-0039 | MEDIUM | FIXED | ele | Analytics labelled every electrician and supervisor bar "undefined"; the dashboard's inspection log was always empty | `e2e/tests/ui-fixes.spec.js` |
| BUG-0040 | MEDIUM | FIXED | asset | Asset, failure and inspection photos were broken images in the admin detail views | `e2e/tests/ui-fixes.spec.js` |
| BUG-0041 | MEDIUM | FIXED | complaints | The guest review page asked the resident to confirm a fix but could not show its proof photo | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0042 | MEDIUM | FIXED | complaints | A ticket the guest rejected was open again but still carried its resolution and verification times | `test/integration/ticket-resolve-verify.test.js` |
| BUG-0043 | MEDIUM | FIXED | ele | Editing an alert rule silently dropped its "notify the location's supervisors / electricians" actions | `e2e/tests/forms.spec.js` |
| BUG-0044 | MEDIUM | FIXED | ele | Tickets raised by an alert rule were unassigned, had no SLA deadline, no audit row, and nobody was told | `test/integration/alert-escalation.test.js` |
| BUG-0045 | MEDIUM | FIXED | ele | Missed-inspection alerts: the night shift was checked during the night, and a second shift or a second rule never alerted | `test/integration/missed-inspection.test.js` |
| BUG-0046 | LOW | FIXED | ele | Token verification accepted any HMAC algorithm, not just the HS256 the app signs | `test/integration/jwt-algorithms.test.js` |
| BUG-0047 | MEDIUM | FIXED | ele | The pages re-sent a submission after a network error, so one tap could create two complaints or tickets | `test/public-escaping.test.js` |
| BUG-0048 | LOW | FIXED | ele | Row actions the server refused (delete a rule, acknowledge an alert, flag an inspection) said nothing | `e2e/tests/forms.spec.js` |
| BUG-0049 | LOW | FIXED | asset | An asset purchase cost of 0 was stored as "unknown" | `test/integration/admin-forms-api.test.js` |
| BUG-0050 | MEDIUM | FIXED | ele | An electrician was rung for a ticket under a deactivated location that their app would not open | `test/integration/worker-coverage-inactive.test.js` |
| BUG-0051 | MEDIUM | FIXED | ele | No sign-in page let anyone ask for a password or PIN reset; the super-admin "Run one-time setup" link was dead | `e2e/tests/forms.spec.js` |
| BUG-0052 | MEDIUM | FIXED | ele | Nobody could change their own password or PIN while signed in | `e2e/tests/forms.spec.js` |
| BUG-0053 | LOW | FIXED | ele | The profile of an electrician said "Admin" | `e2e/tests/forms.spec.js` |
| BUG-0054 | MEDIUM | FIXED | ele | On a shared phone, an inspection saved offline was sent in as whoever else was signed in | `test/shared-device-sessions.test.js` |
| BUG-0055 | MEDIUM | FIXED | ele | Date filters started each day at 05:30 in India (UTC midnight), and pages took "today" from UTC | `test/integration/date-filters-local-day.test.js` |
| BUG-0056 | MEDIUM | FIXED | ele | Analytics charts counted inspections between midnight and 05:30 under the day before | `test/integration/analytics-local-days.test.js` |

Count: 56 bug scenario(s).

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

## BUG-0009 — Permanently deleting a supervisor who created tickets failed with a server error

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** F13 schema-drift diagnosis (2026-10-14), fixed in PR #9
- **Introduced:** pre-audit · **Fixed:** 2026-10-14
- **Description:** DELETE /supervisors/:id/permanent only checked inspection history. Ticket.createdById (and four other references to a user) are ON DELETE RESTRICT in the database, so deleting a supervisor who had created a ticket, marked attendance, been on a duty roster or logged an asset event/failure failed on the foreign key — a 500 instead of a clear 409.
- **Root cause:** The route pre-checked only electricalInspection; the schema declared Ticket.createdBy without onDelete (Prisma default SetNull) while the migrations created RESTRICT, so the gap was invisible from the schema.
- **Expected behavior:** A deactivated supervisor referenced by any RESTRICT foreign key is refused with 409 and the counts; one with no history is deleted (200).
- **Broken behavior:** 500 (foreign-key violation from prisma.user.delete).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js`

**Reproduction steps:**

1. Create an org with an admin, a deactivated supervisor, and a ticket created by that supervisor.
2. As the admin, DELETE /api/supervisors/:id/permanent.
3. Broken: 500. Fixed: 409 { ticketsCreated: 1 } and the supervisor remains.

## BUG-0010 — Electrician and supervisor nav links were double-prefixed (/{org}/{mod}/{org}/{mod}/{page} → 404)

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** navigation
- **Origin:** Production report (GET /jnmc/ele/jnmc/ele/electrician-tickets 404), fixed 2026-10-16
- **Introduced:** 2026-07-24 (530bbd5) · **Fixed:** 2026-10-16
- **Description:** public/js/app.js rewrote the role nav links twice: _applyRoleNavScope ran when the page initialised (initElectrician/initSupervisor) and again after /auth/worker-me (/auth/me) returned (_syncEnabledModulesFor*). The second pass read the already-rewritten href and prefixed it again, so Tickets, My Work and Scan pointed at e.g. /jnmc/ele/jnmc/ele/electrician-tickets and answered 404.
- **Root cause:** _applyRoleNavScope derived the page from getAttribute("href") on every call, which after the first call is already /{org}/{mod}/{page}; stripping only the leading "/" and calling orgPath() again doubled the prefix. E2E never clicked the nav (it navigates with page.goto), so it never saw the result.
- **Expected behavior:** However many times the nav is rewritten, every link is /{org}/{mod}/{page}; links for disabled modules (data-mod) stay hidden.
- **Broken behavior:** After the module sync, links were /{org}/{mod}/{org}/{mod}/{page} and navigating answered 404.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js; e2e/tests/journeys.spec.js › "electrician nav links work after module sync (BUG-0010)" and "supervisor nav links work after module sync (BUG-0010)"`

**Reproduction steps:**

1. Sign in as an electrician (or supervisor) and open electrician-scan (supervisor-scan).
2. Wait for /api/auth/worker-me (/api/auth/me) to complete, then click Tickets.
3. Broken: 404 at /{org}/ele/{org}/ele/electrician-tickets. Fixed: 200 at /{org}/ele/electrician-tickets.

## BUG-0011 — A role nav link hidden until the module sync came back double-prefixed (supervisor Assets → 404)

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** navigation
- **Origin:** e2e explorer (QA-2), first run; fixed 2026-10-17
- **Introduced:** 2026-07-24 (530bbd5); incompletely fixed by BUG-0010 (2026-10-16) · **Fixed:** 2026-10-17
- **Description:** BUG-0010 made _applyRoleNavScope remember each link's page in data-page, but only for links it showed. A link for a module the browser did not yet know was enabled (no localStorage.enabledModules, e.g. a fresh sign-in) was hidden on the first pass without remembering its page; when /auth/me then reported the module, the second pass read the already-rewritten href and prefixed it again. supervisor-assets.html and supervisor-electrical.html also rewrote every #sv-nav href themselves after initSupervisor(), doubling all of them until the sync repaired the visible ones. Found by the e2e explorer: the Assets link on supervisor-assets pointed at /{org}/ele/{org}/ele/supervisor-assets (404).
- **Root cause:** _applyRoleNavScope skipped the data-page capture for links it hid, so a hidden-then-shown link fell back to re-reading its href; and two supervisor pages repeated the nav rewrite inline from getAttribute("href").
- **Expected behavior:** Every role nav link is /{org}/{mod}/{page} after init and after the module sync, whether or not it was hidden at first; no page rewrites #sv-nav hrefs itself.
- **Broken behavior:** On supervisor-assets the Assets link became /{org}/ele/{org}/ele/supervisor-assets (404); on supervisor-assets and supervisor-electrical every nav link was double-prefixed until /auth/me answered.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › "supervisor › supervisor-assets" and "supervisor › supervisor-electrical"`

**Reproduction steps:**

1. Org with the assets module on. Sign in as a supervisor in a browser with no localStorage.enabledModules.
2. Open /{org}/ele/supervisor-assets and wait for /api/auth/me.
3. Broken: the Assets link is /{org}/ele/{org}/ele/supervisor-assets. Fixed: /{org}/ele/supervisor-assets.

## BUG-0012 — Admin analytics showed "undefined" for inspection records, flagged records and the location breakdown

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** QA-2 visual baselines (2026-10-17); fixed 2026-10-18
- **Introduced:** pre-audit · **Fixed:** 2026-10-18
- **Description:** admin-analytics.html read summary.totalRecords / flaggedRecords and locationBreakdown[].cleaned / expected / completionRate, names the API (GET /api/analytics/report) does not send — it sends totalInspections, flaggedInspections and inspections. The cards and the table printed "undefined" and "undefined%". Found by the QA-2 visual baselines.
- **Root cause:** The analytics page kept the field names of an older report shape; the API had been renamed (inspections) and never sent per-location schedule data.
- **Expected behavior:** Every field the page renders unguarded exists in the API response; Expected and Completion show "—" when the API sends no schedule data.
- **Broken behavior:** Inspection Records, Flagged Records, Inspected and Expected showed "undefined"; Completion showed "undefined%".
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › rawValue check (admin › admin-analytics)`

**Reproduction steps:**

1. Sign in as an admin of an org with a location and no inspections.
2. Open /{org}/ele/admin-analytics.
3. Broken: "undefined" in the first two cards and the Location Breakdown. Fixed: 0 and "—".

## BUG-0013 — Four admin pages had no working admin nav (assets, electrical, failures: run-together links and a too-wide page on phones; predictions: none at all)

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** QA-2 visual baselines and the explorer (F17), 2026-10-17; fixed 2026-10-18
- **Introduced:** pre-audit · **Fixed:** 2026-10-18
- **Description:** admin-assets, admin-electrical and admin-failures rendered #topbar-nav without the topbar-nav class (an unstyled row of touching links, about 1030 px wide on a phone — F17) and used <main class="main-content">, a class defined nowhere. admin-predictions had a <nav class="sidebar"> and no topbar, so no navigation. admin-alerts had no #nav-toggle, so its nav could not be opened on a phone. Found by the QA-2 visual baselines.
- **Root cause:** These pages were built outside the shared admin page shell (topbar markup + container) that the other admin pages and App.initAdmin rely on.
- **Expected behavior:** Every admin page has the shared shell: <div class="topbar-nav" id="topbar-nav">, the #nav-toggle menu button, and the shared layout classes.
- **Broken behavior:** Nav links ran together and the page overflowed on a phone (assets, electrical, failures); no nav at all (predictions); no phone menu (alerts).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js; e2e/tests/explorer.spec.js › nav and overflow checks (admin pages)`

**Reproduction steps:**

1. Sign in as an admin and open /{org}/ele/admin-assets (or electrical, failures, predictions, alerts).
2. Broken: the nav links touch / are missing, and on a phone the page scrolls sideways. Fixed: the same nav as admin-tickets.

## BUG-0014 — The admin Alerts page was always dark, unlike every other admin page

- **Severity:** LOW · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** QA-2 visual baselines (2026-10-17); fixed 2026-10-18
- **Introduced:** pre-audit · **Fixed:** 2026-10-18
- **Description:** admin-alerts.html hard-coded <html data-theme="dark">, so the page switched to the dark token set while the rest of the admin app is light. Its own styles already used the design tokens. Found by the QA-2 visual baselines.
- **Root cause:** A data-theme="dark" attribute left on the page's <html> element.
- **Expected behavior:** No admin page forces a theme on <html>; they all use the admin design tokens.
- **Broken behavior:** admin-alerts rendered in the dark theme.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/bug-regressions.test.js; e2e visual baseline admin-alerts`

**Reproduction steps:**

1. Sign in as an admin and open /{org}/ele/admin-alerts.
2. Broken: a dark page. Fixed: the light admin theme.

## BUG-0015 — An electrician could "resolve" a ticket that a supervisor had already verified, sending it back to verification

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Bug hunt 2026-10-20 (ticket lifecycle, every role)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** POST /worker/tickets/:id/resolve refused only CLOSED and CANCELLED tickets. A verified (RESOLVED) ticket, or one already waiting for verification, could be resolved again: a verified ticket dropped back to RESOLVED_PENDING_VERIFY and its proof photo was replaced. The electrician app only offers "Resolve With Photo" on open and in-progress tickets; the server did not enforce it.
- **Root cause:** worker-auth.js resolve checked status against CLOSED/CANCELLED only, not against the active statuses (OPEN, ACKNOWLEDGED, ASSIGNED, IN_PROGRESS, ON_HOLD) the UI allows.
- **Expected behavior:** Resolving a RESOLVED or RESOLVED_PENDING_VERIFY ticket answers 400 and leaves the ticket unchanged; resolving straight from OPEN stays allowed.
- **Broken behavior:** 200: a verified ticket became RESOLVED_PENDING_VERIFY again, with the new photo.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create an org, a location, an electrician covering it, and a RESOLVED (verified) ticket there.
2. As the electrician, POST /api/worker/tickets/:id/resolve with a proof photo.
3. Broken: 200 and status RESOLVED_PENDING_VERIFY. Fixed: 400 and status still RESOLVED.

## BUG-0016 — A reopened public ticket could still be closed by the guest's old review link, or by the review auto-close

- **Severity:** HIGH · **Status:** FIXED · **Module:** complaints · **Category:** ticket-workflow
- **Origin:** Bug hunt 2026-10-20 (ticket lifecycle, every role)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** When an admin moved a resolved public ticket back to an active status (PATCH /tickets/:id), the resolution fields were cleared but the pending guest review was not. The old review link still CONFIRMED the resolution — closing a ticket that was being worked on again — and once the 30-minute review window passed, the lazy auto-close on GET /tickets closed it too.
- **Root cause:** tickets.js PATCH cleared resolvedAt/verifiedAt and friends but not reviewToken/reviewStatus/reviewExpiresAt; autoCloseExpiredReviews closed any PUBLIC ticket with a PENDING review, whatever its status.
- **Expected behavior:** Moving a ticket back to an active status withdraws a pending guest review (the link answers 404), and the auto-close only ever closes RESOLVED tickets.
- **Broken behavior:** The guest's CONFIRM answered 200 and the reopened ticket became CLOSED.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create an org with an admin and a PUBLIC ticket that is RESOLVED with a PENDING guest review.
2. As the admin, PATCH /api/tickets/:id { status: "IN_PROGRESS" }.
3. As the guest, POST /api/public/review/:token { action: "CONFIRM" }.
4. Broken: 200 and the ticket is CLOSED. Fixed: 404 and the ticket stays IN_PROGRESS.

## BUG-0017 — After a guest rejected a fix, the next verified fix never got a guest review

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** ticket-workflow
- **Origin:** Bug hunt 2026-10-20 (ticket lifecycle, every role)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** POST /tickets/:id/verify issued a guest review link only when the ticket had no review token at all. After a guest rejected the first resolution, the ticket kept its spent (REJECTED) token, so verifying the second fix issued no new link: the supervisor was handed the old one, which says "already reviewed", and the ticket stayed RESOLVED instead of going to the guest.
- **Root cause:** tickets.js verify tested `!ticket.reviewToken` instead of whether a review is currently pending.
- **Expected behavior:** Verifying a public ticket issues a fresh review link unless a review is already pending.
- **Broken behavior:** The response carried the old, already-rejected link; the guest could not review the second fix.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create a PUBLIC ticket in RESOLVED_PENDING_VERIFY whose earlier review the guest REJECTED.
2. As the admin, POST /api/tickets/:id/verify.
3. Broken: reviewUrl is the old token ("already reviewed"). Fixed: a new token whose review page is pending.

## BUG-0018 — The electrician was never told that their fix was verified, or that it was sent back and why

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** notification
- **Origin:** Bug hunt 2026-10-20 (ticket lifecycle, every role)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** POST /tickets/:id/verify and POST /tickets/:id/reopen notified only the admins. The code comments said "notify workers", but the electrician who resolved the ticket got nothing: a rejected fix silently reappeared as in-progress, with the supervisor's reason visible nowhere in their app.
- **Root cause:** tickets.js verify had an empty "Notify workers who resolved it" block; reopen called notifyAdmins under a "notify workers" comment.
- **Expected behavior:** Verify notifies the ticket's resolving electricians (ticket_verified); reopen does too (ticket_reopened), with the supervisor's note.
- **Broken behavior:** No Notification row for the electrician on either action.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create two RESOLVED_PENDING_VERIFY tickets resolved by an electrician.
2. As the admin, verify one and reopen the other with a note.
3. Broken: the electrician has no notification. Fixed: ticket_verified and ticket_reopened (with the note).

## BUG-0019 — Alert escalations never reached the supervisors or electricians of the location, nor raised their ticket

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** notification
- **Origin:** Bug hunt 2026-10-20 (scheduler: ESCALATION_CHECKS)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** An alert rule can escalate an unacknowledged alert to the supervisors and electricians assigned to the location, and raise a ticket there. The escalation engine reads the location from the stored alert (metadata.locationId), but no alert ever stored it: the event payloads carry locationId at the top level and fireAlert kept only data.metadata. Every such escalation silently reached no one; only the generic "escalation" notice to the admins went out.
- **Root cause:** services/automation.js fireAlert stored `metadata: data.metadata || null`; runEscalationChecks passes `alert.metadata?.locationId` to the escalation actions, which return early without a location.
- **Expected behavior:** An alert raised for a location records it (metadata.locationId/module), so NOTIFY_ASSIGNED_SUPERVISORS, NOTIFY_ASSIGNED_WORKERS and CREATE_TICKET work on escalation.
- **Broken behavior:** The escalated alert notified no supervisor or electrician of the location and raised no ticket.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/alert-escalation.test.js`

**Reproduction steps:**

1. Create an org, a location with an assigned supervisor, and a TICKET_HIGH_PRIORITY rule escalating after 10 minutes to NOTIFY_ASSIGNED_SUPERVISORS.
2. As the admin, POST /api/tickets with priority HIGH; back-date the alert 11 minutes; run runEscalationChecks().
3. Broken: the supervisor has no notification for the alert. Fixed: one.

## BUG-0020 — A guest complaint could be filed under a module the organization had not enabled

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** public-complaint
- **Origin:** Bug hunt 2026-10-20 (authorization: disabled module)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** POST /api/public/complaint checked only that the module code was one of the platform's modules, not that the organization had it enabled. A crafted request, or a QR page left open while an admin switched a module off, created a ticket in a module the organization does not have — rung to its electricians and supervisors, but outside every module-scoped list. POST /api/tickets already refused this for staff (403).
- **Root cause:** public.js validated `VALID_MODULES.includes(mod)` only; the location lookup did not load the organization's enabledModules.
- **Expected behavior:** A complaint for a module the organization has not enabled answers 400 and creates nothing; enabled modules work as before.
- **Broken behavior:** 200 and a ticket in the disabled module.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/authz-sweep.test.js`

**Reproduction steps:**

1. Create an org with enabledModules ["ele"] and a location.
2. As a guest, POST /api/public/complaint { locationId, module: "civil", issueType: "PLUMBING_LEAK" }.
3. Broken: 200 and a civil ticket. Fixed: 400 and no ticket.

## BUG-0021 — Clearing an optional field in the asset, location or alert-rule edit form was not saved

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** asset · **Category:** admin-workflow
- **Origin:** Bug hunt 2026-10-20 (every button and form)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** The edit forms sent `undefined` for a field the admin emptied, so the key was dropped from the request and the server — for which an omitted key means "unchanged" — kept the old value: an asset's make, model, serial, rated capacity, description, install/warranty/maintenance dates, maintenance cycle and purchase cost; a location's notes, and moving it back to "None (Top Level)"; an alert rule's description. The page said "updated" and the old value came back. The asset API also refused null for its two numeric fields, so they could not be cleared at all.
- **Root cause:** admin-assets.html, admin-locations.html and admin-alerts.html built the PATCH body with `value || undefined` (and `if (parentId)`); assets.js updateAssetSchema was createAssetSchema.partial(), whose numbers are not nullable.
- **Expected behavior:** On edit, a cleared field is sent empty ("" or null) and stored as empty; an omitted field is still unchanged.
- **Broken behavior:** The cleared value reappeared after saving; PATCH /assets/:id with purchaseCost: null answered 400.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Create an asset with a make, a warranty date and a purchase cost.
2. As the admin, PATCH /api/assets/:id { make: "", warrantyExpiry: "", purchaseCost: null } (what the fixed form sends).
3. Broken: 400 (purchaseCost null). Fixed: 200 and all three are empty. The browser side is e2e/tests/forms.spec.js (BUG-0021 ×3).

## BUG-0022 — On a phone that cannot scan QR codes (iPhone Safari), "Open Camera" switched the camera on with nothing reading it

- **Severity:** LOW · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** Bug hunt 2026-10-20 (QR scan without BarcodeDetector)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** The electrician and supervisor scan pages opened the camera first and only then checked for BarcodeDetector. On iPhone Safari (no BarcodeDetector) the live camera stayed on — privacy indicator lit, battery used — under a "not supported, enter the code manually" message, until the user found Stop. Manual code entry itself worked.
- **Root cause:** startCamera() called getUserMedia before testing `'BarcodeDetector' in window`, and never stopped the stream in the unsupported branch.
- **Expected behavior:** Without QR support (no BarcodeDetector, or one without qr_code) the camera is never opened; the page says so and focuses the code field.
- **Broken behavior:** getUserMedia ran and the video stayed live with nothing scanning.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Open the electrician (or supervisor) Scan page in a browser without BarcodeDetector.
2. Tap "Open Camera".
3. Broken: the camera turns on. Fixed: it stays off and the manual code field is focused. Browser test: e2e/tests/forms.spec.js (BUG-0022).

## BUG-0023 — A super-admin could not create an organization without entering an email

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Bug hunt 2026-10-20 (super-admin forms)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** The "New Organization" form sends an empty Email field as "". POST /api/superadmin/organizations validated email as `z.string().email().optional()`, which refuses "", so every organization created without an email failed with 400 "Validation failed" (the edit route already accepted "").
- **Root cause:** superadmin.js create schema lacked `.or(z.literal(''))` on email, unlike the PATCH schema.
- **Expected behavior:** An empty email is accepted and stored as no email; an invalid email is still refused.
- **Broken behavior:** 400 Validation failed (email: Invalid email).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/superadmin-org-form.test.js`

**Reproduction steps:**

1. As a super-admin, POST /api/superadmin/organizations with { name, slug, type, enabledModules: ["ele"], phone: "", email: "", address: "" }.
2. Broken: 400. Fixed: 200 and email is null.

## BUG-0024 — After logging an asset event or reporting a failure, the supervisor saw a blank page

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** asset · **Category:** ui
- **Origin:** Bug hunt 2026-10-20 (every button and form)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** supervisor-assets.html hid the main view and showed the confirmation with `successView.style.display = ''`. The page's stylesheet has `.success-screen { display: none }`, so clearing the inline style left the confirmation hidden: below the nav bar the page was empty, with no "Back to Asset" button. The event or failure itself was saved.
- **Root cause:** showSuccess() set display to the empty string on an element whose CSS default is display:none.
- **Expected behavior:** The confirmation ("Event Logged!" / "Failure Reported!") is shown, with "Back to Asset".
- **Broken behavior:** A blank page under the nav bar.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. As a supervisor, open Assets, pick an asset, Log Inspection with a summary, submit.
2. Broken: blank page. Fixed: the confirmation. Browser test: e2e/tests/forms.spec.js (BUG-0024).

## BUG-0025 — A new duty roster suggested no electrician when they covered the floor from its building

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** supervisor-workflow
- **Origin:** Bug hunt 2026-10-20 (every button and form)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** GET /api/duty-roster/suggested-workers counted only electricians assigned to that exact location. Electricians are usually assigned to a building with "cover children", and the roster picker lists floors and rooms, so the supervisor got no pre-selected electrician and the roster started empty. Everywhere else (the complaint ring, the electrician app) coverage includes an ancestor with coverChildren.
- **Root cause:** duty-roster.js queried workerAssignment by locationId only instead of using assignment-resolver getAssignedWorkerIds (direct + ancestors with coverChildren).
- **Expected behavior:** The suggestion lists the active electricians covering the location, directly or through an ancestor with coverChildren, and no one else.
- **Broken behavior:** An empty suggestion for a floor covered from its building.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/admin-forms-api.test.js`

**Reproduction steps:**

1. Create a building and a floor in it; assign an electrician to the building with coverChildren.
2. As a supervisor, GET /api/duty-roster/suggested-workers?locationId=<floor>.
3. Broken: suggested is []. Fixed: it contains the electrician.

## BUG-0026 — After a guest rejected a fix, the electrician who did it saw the ticket as "Done" and could not pick it up again

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** ticket-workflow
- **Origin:** Bug hunt 2026-10-20 (ticket lifecycle, every role)
- **Introduced:** pre-audit · **Fixed:** 2026-10-20
- **Description:** POST /api/public/review/:token with REJECT reopened the ticket (OPEN, unassigned) but left the resolving electricians connected to it. The worker pool excludes tickets the electrician is connected to, and the app shows a connected OPEN ticket with neither Pick Up nor Resolve, only "✓ Done": the electrician who knew the job could not take it back, and nobody told them the guest said it was not fixed.
- **Root cause:** public.js REJECT updated status/assignee/review fields only; the supervisor's /reopen already clears resolvedWorkers for this reason.
- **Expected behavior:** A guest rejection disconnects the resolving electricians (the ticket is back in their pool) and notifies them with the guest's note; the guest's verdict and note stay on the ticket.
- **Broken behavior:** The ticket was missing from the electrician's pool and showed "Done" in their app; no notification.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create a PUBLIC ticket, RESOLVED by an electrician, with a pending guest review.
2. As the guest, POST /api/public/review/:token { action: "REJECT", note }.
3. Broken: the electrician is still in resolvedWorkers and has no notification. Fixed: disconnected, and a ticket_review_rejected notification with the note.

## BUG-0027 — The electrician API returned the guest's review token, name, phone, IP hash and user agent

- **Severity:** CRITICAL · **Status:** FIXED · **Module:** ele · **Category:** data-exposure
- **Origin:** Product and architecture review 2026-10 (PAR-10/14)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** Every electrician ticket route (list, detail, pool, my work, pickup, resolve) read tickets with a bare Prisma `include`, which returns every column. The response carried the guest's secret review token — with it, the electrician who did the work could "confirm as the resident" and close it — and the guest's name, phone, IP hash, user agent and risk score. The staff routes strip the token; the electrician routes did not. Found by the 2026-10 product and architecture review (PAR-10/14).
- **Root cause:** worker-auth.js used `include` (all scalar columns + relations) instead of an explicit `select` for every ticket it returns.
- **Expected behavior:** Electrician ticket responses carry only the fields the electrician app uses; no review token or guest personal data.
- **Broken behavior:** GET /api/worker/tickets/:id returned reviewToken, guestName, guestPhone, sourceIp, userAgent and riskScore.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Create an org, a location, an electrician covering it, and a PUBLIC ticket awaiting guest review there, with guest name and phone.
2. As the electrician, GET /api/worker/tickets/:id.
3. Broken: the JSON contains reviewToken and guestPhone. Fixed: neither key is present.

## BUG-0028 — Stored XSS: an org admin could plant script in names that ran for anyone opening the page, including a super-admin

- **Severity:** CRITICAL · **Status:** FIXED · **Module:** ele · **Category:** data-exposure
- **Origin:** Product and architecture review 2026-10 (PAR-10/29)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** App.esc built its output with textContent → innerHTML, which escapes & < > but not quotes, and 42 places put its output inside double-quoted attributes (title, data-name, value) with names an org admin types — a location named `x" onmouseover="…` gained a live handler. Fifteen inline onclick handlers passed names as esc(name).replace(/'/g, "\\'"), which a backslash or a double quote defeats. The CSP allows inline handlers, and a super-admin who enters the org opens these pages with a token for every tenant. Found by the 2026-10 product and architecture review (PAR-10/29).
- **Root cause:** App.esc did not escape " and '; inline handlers HTML-escaped (not JS-escaped) their string arguments.
- **Expected behavior:** App.esc escapes & < > " '; inline handlers take App.escJs(text), which escapes for JS and then for HTML, so the exact text arrives as one argument.
- **Broken behavior:** A location named `x" data-x="1` rendered an extra attribute on admin-locations; an electrician named `x\');alert(1);//` ran code when Locations was clicked.
- **Scenario dependencies:** —
- **Regression test:** `test/public-escaping.test.js`

**Reproduction steps:**

1. As an org admin, create a location named `Q" data-bug0028="1` and an electrician named `E\');window.__bug0028=1;//`.
2. Open admin-locations, then admin-workers and click the electrician's Locations button.
3. Broken: an element carries data-bug0028 and window.__bug0028 is 1. Fixed: neither. Browser test: e2e/tests/forms.spec.js (BUG-0028).

## BUG-0029 — `npm test` passed when a test file's describe() threw while collecting its tests

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** qa-tooling
- **Origin:** PAR-10 fixes 2026-10-25 (found while writing the BUG-0028 test)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** On Node 24, when a describe() body throws (a broken require, a bad helper call), node --test prints the suite as failed but exits 0 and counts "fail 0": none of that suite's tests run. scripts/run-tests.js decided its exit code from the child's status and those counts, so CI was green with the tests silently missing. Found while writing the BUG-0028 test.
- **Root cause:** scripts/report-tests.js decideExit() trusted node:test's counts, which leave out a suite that fails during collection; the JUnit XML and the events stream both record it.
- **Expected behavior:** A suite that throws while collecting its tests makes the run exit 1, with the suite named in the reasons and in test-summary.md.
- **Broken behavior:** Exit 0; the summary said 0 failed.
- **Scenario dependencies:** —
- **Regression test:** `test/report-tests.test.js`

**Reproduction steps:**

1. Add a test file whose describe() callback throws before registering any test.
2. Run node scripts/run-tests.js on it.
3. Broken: "[run-tests] exit 0". Fixed: exit 1, "1 failure(s) the runner did not count …".

## BUG-0030 — Supervisors' Aadhaar numbers and blood groups were stored in plain text and copied into audit logs

- **Severity:** CRITICAL · **Status:** FIXED · **Module:** ele · **Category:** data-exposure
- **Origin:** Product and architecture review 2026-10 (PAR-10/15)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** POST /api/supervisors and PATCH /api/supervisors/:id wrote User.aadharNo and User.bloodGroup as typed. Only electricians' (Worker) values went through lib/crypto.js. Every supervisor edit also copied the old and new values into AuditLog.newValue as { from, to }, and from there into every backup. The Engineering Charter (§6) requires these fields encrypted at rest, and docs/architecture/data-model.md said they were. Found by the 2026-10 product and architecture review (PAR-10/15).
- **Root cause:** supervisors.js never called the PII encryption helpers (they were named and used for workers only), and its audit diff recorded every changed field's raw values.
- **Expected behavior:** Both fields are stored encrypted ("v1:…") and read back decrypted by the admin; audit rows record { changed: true } for them. scripts/migrate-user-pii.js encrypts rows saved before the fix.
- **Broken behavior:** The database row and the audit row held the Aadhaar number as typed.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/supervisor-pii.test.js`

**Reproduction steps:**

1. As an org admin, POST /api/supervisors with an aadharNo, then PATCH it to another number.
2. Read User.aadharNo and the supervisor_updated AuditLog row directly from the database.
3. Broken: both hold the numbers in plain text. Fixed: the row holds "v1:…" and the audit row { changed: true }.

## BUG-0031 — Worker detail, create and update responses carried the PIN hash and a pending PIN-reset token

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** data-exposure
- **Origin:** Product and architecture review 2026-10 (PAR-10/16)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** GET /api/workers/:id, POST /api/workers, PATCH /api/workers/:id and the super-admin worker create/update routes returned the whole Worker row: pinHash, resetToken (a pending token sets the electrician's PIN), resetTokenExpiresAt and tokenInvalidBefore. The list routes already used an explicit select. Found by the 2026-10 product and architecture review (PAR-10/16).
- **Root cause:** Those routes read and wrote Worker without a select, so Prisma returned every column.
- **Expected behavior:** They return WORKER_PROFILE_SELECT (lib/security.js): the profile, no credential material.
- **Broken behavior:** The JSON contained pinHash (a bcrypt hash) and resetToken.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/worker-credentials.test.js`

**Reproduction steps:**

1. Create an electrician with a PIN and a pending PIN-reset token.
2. As the org admin, GET /api/workers/:id.
3. Broken: pinHash and resetToken are in the response. Fixed: neither key is present.

## BUG-0032 — An org admin's "run escalations" escalated every tenant's alerts, outside the scheduler lock

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/01, PAR-10/42)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** POST /api/alerts/run-checks and /api/alerts/run-escalations (ORG_ADMIN) started the platform-wide jobs: every organization's scheduled checks and escalations. They ran outside the scheduler's advisory lock, so next to the 5-minute scheduled run the same alert could escalate twice. The escalation scan also escalated alerts of suspended and deleted organizations. Found by the 2026-10 product and architecture review (PAR-10/01, PAR-10/42).
- **Root cause:** The routes called runScheduledChecks / runEscalationChecks with no org scope and without runExclusive; the escalation rule query had no organization-status filter.
- **Expected behavior:** A manual run covers the caller's org only, under the scheduled job's lock (409 while it is held); suspended and deleted orgs never escalate.
- **Broken behavior:** Org A's admin calling run-escalations escalated org B's overdue alert.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/alert-manual-checks.test.js`

**Reproduction steps:**

1. Create two orgs, each with a rule that escalates after 1 minute and an unacknowledged alert 30 minutes old.
2. As org A's admin, POST /api/alerts/run-escalations.
3. Broken: org B's alert reaches escalation level 1. Fixed: it stays at 0; org A's escalates.

## BUG-0033 — A proof photo uploaded late in an old ticket's life was deleted the next night

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/18)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** The daily image cleanup keeps photos for 30 days, but it counted a ticket's proof photo (resolvedImageUrl) from the TICKET's creation. When work on a ticket older than 30 days was finished, its new proof photo was deleted at the next cleanup — before the supervisor verified it or the resident saw it. Found by the 2026-10 product and architecture review (PAR-10/18).
- **Root cause:** cleanupExpiredImages selected tickets by createdAt < cutoff and removed both photos.
- **Expected behavior:** Each photo is kept for 30 days from when it was taken: the complaint photo from the ticket's creation, the proof photo from resolvedAt.
- **Broken behavior:** A proof photo resolved 2 days ago on a 40-day-old ticket was deleted.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/image-cleanup.test.js`

**Reproduction steps:**

1. Create a ticket 40 days ago that was resolved 2 days ago with a proof photo.
2. Run the image cleanup (services/cleanup.js cleanupExpiredImages).
3. Broken: resolvedImageUrl is null. Fixed: it is kept. Full test with real files and the real query: test/integration/image-cleanup.test.js.

## BUG-0034 — Password and PIN reset tokens were stored as issued, so the database value itself reset the account

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** account-recovery
- **Origin:** Product and architecture review 2026-10 (PAR-10/21)
- **Introduced:** 2026-07-21 ([WP14]) · **Fixed:** 2026-10-25
- **Description:** POST /api/auth/forgot-password and /api/auth/worker-forgot-pin stored the e-mailed reset token unchanged in User.resetToken / Worker.resetToken, and the reset routes looked it up as is. Anyone who could read the database or a backup could reset the password or PIN of any account with a pending request. Found by the 2026-10 product and architecture review (PAR-10/21).
- **Root cause:** The [WP14] recovery pattern stored the raw token; nothing hashed it before the write or the lookup.
- **Expected behavior:** Only the token's SHA-256 digest is stored (hashResetToken); the stored value submitted as a token is refused.
- **Broken behavior:** Submitting User.resetToken from the database to /api/auth/reset-password changed the password (200).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/account-recovery.test.js`

**Reproduction steps:**

1. POST /api/auth/forgot-password for an existing staff email.
2. Read User.resetToken from the database and POST it to /api/auth/reset-password with a new password.
3. Broken: 200, password changed. Fixed: 400.

## BUG-0035 — Permanently deleting an electrician who was on a duty roster failed with a 500; attendance history was silently erased

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/20)
- **Introduced:** 2026-03-22 (duty rosters) · **Fixed:** 2026-10-25
- **Description:** DELETE /api/workers/:id/permanent checked only inspection history. DutyRosterWorker references Worker with ON DELETE RESTRICT, so for anyone ever put on a roster the delete failed with a foreign-key error (500). Attendance records and the worker's link to tickets they resolved cascade, so for those workers the delete went through and silently erased that history — against the rule that history-bearing deletes are refused (409, [WP17]). Found by the 2026-10 product and architecture review (PAR-10/20).
- **Root cause:** The [WP17] dependency check counted inspections only; rosters, attendance and resolved tickets were added later without extending it.
- **Expected behavior:** The delete is refused with 409 and counts of every history that names the worker; nothing is deleted.
- **Broken behavior:** A worker on a roster: 500 "Database error". A worker with attendance records: deleted, attendance gone.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/permanent-delete-parity.test.js`

**Reproduction steps:**

1. Deactivate an electrician who is on a duty roster.
2. DELETE /api/workers/:id/permanent as the org admin.
3. Broken: 500. Fixed: 409 with dutyRosters: 1.

## BUG-0036 — `npm test` passed when a suite's after() hook threw — e.g. a cleanup that left test data behind

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** qa-tooling
- **Origin:** PAR-10 fixes 2026-10-25 (found while writing the BUG-0035 test)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** On Node 24 a suite hook that throws after its tests have passed (typically after() calling cleanupTestOrgs) is reported as a failed suite, but node --test exits 0 with "fail 0", and the JUnit XML shows a passing suite. BUG-0029's check covered only a describe() body that throws. Found when a new test's roster made the org cleanup fail (DutyRosterWorker RESTRICT) and the run stayed green.
- **Root cause:** scripts/report-tests.js counted only suite failures of type testCodeFailure as uncounted; hookFailed was ignored, and only the events stream records it.
- **Expected behavior:** A suite whose hook throws makes the run exit 1, with the suite named in the reasons.
- **Broken behavior:** Exit 0, "fail 0"; the cleanup failure and the leftover data went unnoticed.
- **Scenario dependencies:** —
- **Regression test:** `test/report-tests.test.js`

**Reproduction steps:**

1. Add a test file whose describe() has an after() that throws, and a passing test.
2. Run node scripts/run-tests.js on it.
3. Broken: "[run-tests] exit 0". Fixed: exit 1, "1 suite failure(s) the runner did not count …".

## BUG-0037 — A deactivated (or moved) supervisor kept their open tickets, where no one else could see them

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** supervisor-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/09)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** Deactivating a supervisor (PATCH /api/supervisors/:id, DELETE /api/supervisors/:id, or the super-admin user edit) left their open tickets assigned to them. Other supervisors only see tickets assigned to themselves or unassigned, and only the assigned supervisor or an admin may verify, so the work stranded. A super-admin moving the user to another org also left the tickets — and the user's coverage, so new complaints kept going to someone in another org. Found by the 2026-10 product and architecture review (PAR-10/09).
- **Root cause:** The deactivation paths only flipped isActive; nothing re-ran the assignment rule for the tickets they held.
- **Expected behavior:** Each open ticket goes to the nearest active supervisor covering its location, else back to the pool; audited, and the new assignee is notified. A move also drops the old org's coverage.
- **Broken behavior:** The open ticket stayed assigned to the deactivated supervisor.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/supervisor-handover.test.js`

**Reproduction steps:**

1. Give a supervisor an OPEN ticket at a location another supervisor also covers.
2. Deactivate the first supervisor as the org admin.
3. Broken: the ticket is still theirs. Fixed: it belongs to the other supervisor.

## BUG-0038 — Two people acting on one ticket at once both "succeeded" — the last write won

- **Severity:** HIGH · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/05)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** Every ticket transition read the ticket, checked its status, then updated it by id alone. Two requests at the same moment both passed the check: a fix was verified AND sent back (verify 200, reopen 200), verified twice (two audit rows, two notifications), or picked up by two supervisors. The same held for an electrician's resolve and the guest's review. Found by the 2026-10 product and architecture review (PAR-10/05).
- **Root cause:** Read-check-write without a condition on the write; nothing stopped the second write after the first changed the status.
- **Expected behavior:** Each transition writes only if the status is still the one it checked (updateTicketIfUnchanged); the loser answers 409 (or 400 once the change is visible). The admin's generic edit stays an explicit override.
- **Broken behavior:** Two concurrent verifies of one ticket both answered 200.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-concurrency.test.js`

**Reproduction steps:**

1. Create a ticket waiting for verification, assigned to a supervisor.
2. Send POST /api/tickets/:id/verify as that supervisor and as an admin at the same moment.
3. Broken: both 200. Fixed: exactly one 200.

## BUG-0039 — Analytics labelled every electrician and supervisor bar "undefined"; the dashboard's inspection log was always empty

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** Product and architecture review 2026-10 (PAR-10/27) and the full e2e run (explorer rawValue on admin-analytics)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** admin-analytics.html read topWorkers[].records and topSupervisors[].records; GET /api/analytics/report sends `inspections`, so each performance bar showed "undefined" with a NaN width. admin-dashboard.html read `inspections` from GET /api/electrical-inspections, which sends `records`, so "Today's Inspection Log" always said "No inspections logged today" (PAR-10/27). Both show only when inspections exist, which is why the explorer flagged the first only in full runs. Found by the 2026-10 product and architecture review and the full local e2e run.
- **Root cause:** The pages kept field names the APIs do not send (the BUG-0012 class).
- **Expected behavior:** Every field the performance bars and the inspection log read exists in the API responses.
- **Broken behavior:** Bars labelled "undefined"; the log always empty.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/ui-fixes.spec.js`

**Reproduction steps:**

1. Sign in as an admin of an org with an inspection today that names an electrician.
2. Open admin-analytics, then admin-dashboard.
3. Broken: the bars read "undefined"; the log says "No inspections logged today". Browser test: e2e/tests/ui-fixes.spec.js (BUG-0039).

## BUG-0040 — Asset, failure and inspection photos were broken images in the admin detail views

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** asset · **Category:** ui
- **Origin:** Product and architecture review 2026-10 (PAR-10/24)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** admin-assets, admin-failures and admin-electrical rendered stored photos by their raw /images/... path. Images are served only through /api/images/... with the viewer's token (App.imgUrl, F15), so every such photo failed to load — the admin could not see the evidence attached to an asset, a failure report or an inspection. The visual and explorer fixtures carried no photos, so nothing noticed. Found by the 2026-10 product and architecture review (PAR-10/24).
- **Root cause:** Those three detail views built <img src> from img.imageUrl directly instead of App.imgUrl(img.imageUrl).
- **Expected behavior:** Every stored photo in the three detail views is requested through App.imgUrl, and loads.
- **Broken behavior:** The images loaded /images/uploads/... and got 404.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/ui-fixes.spec.js`

**Reproduction steps:**

1. Attach a stored photo to an asset (or a failure, or an inspection).
2. Open admin-assets (admin-failures, admin-electrical) and press View on that row.
3. Broken: a broken image. Fixed: the photo shows. Browser test: e2e/tests/ui-fixes.spec.js (BUG-0040).

## BUG-0041 — The guest review page asked the resident to confirm a fix but could not show its proof photo

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** public-complaint
- **Origin:** Product and architecture review 2026-10 (PAR-10/23)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** GET /api/public/review/:token returned the proof photo's raw /images/... path, and review.html used it as the image source. Photos are served only through /api/images/... with a staff or electrician token; the guest has neither, so the photo they were asked to judge never loaded. Found by the 2026-10 product and architecture review (PAR-10/23).
- **Root cause:** The review flow had no way to serve the photo to a holder of the review link.
- **Expected behavior:** The review response gives photoUrl = /api/public/review/:token/photo (not the storage path); that route serves only this ticket's proof photo while its review is open, and 404 otherwise.
- **Broken behavior:** The review page showed a broken image.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Resolve a public ticket with a proof photo so a guest review link is issued.
2. Open /review/:token as the guest.
3. Broken: a broken image. Fixed: the photo shows. Browser test: e2e/tests/journeys.spec.js J5; API test: ticket-resolve-verify.test.js (BUG-0041).

## BUG-0042 — A ticket the guest rejected was open again but still carried its resolution and verification times

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** complaints · **Category:** ticket-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/55)
- **Introduced:** 2026-10-20 (BUG-0026 kept the resolution on purpose; the times came with it) · **Fixed:** 2026-10-25
- **Description:** POST /api/public/review/:token with REJECT reopened the ticket (OPEN, back to the pool) but left resolvedAt, verifiedAt, verifiedById and verifyNote set. Every other reopen clears them ([WP10]). Analytics counts any ticket with resolvedAt as resolved, so a rejected, open ticket counted as resolved with a stale resolution time. The photo and note stay on purpose (BUG-0026). Found by the 2026-10 product and architecture review (PAR-10/55).
- **Root cause:** The REJECT update cleared the assignee and electricians but not the resolution and verification timestamps.
- **Expected behavior:** After a guest rejection the ticket is OPEN with resolvedAt, verifiedAt, verifiedById and verifyNote null; its photo and the guest's note stay.
- **Broken behavior:** OPEN, with resolvedAt and verifiedAt from the rejected fix.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/ticket-resolve-verify.test.js`

**Reproduction steps:**

1. Verify a public ticket so a guest review opens.
2. POST /api/public/review/:token with { action: "REJECT" }.
3. Broken: resolvedAt and verifiedAt still set. Fixed: both null.

## BUG-0043 — Editing an alert rule silently dropped its "notify the location's supervisors / electricians" actions

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/51)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** The alert-rule form offered only Notify Admins, Notify Supervisors and Create Ticket, but the API accepts NOTIFY_ASSIGNED_SUPERVISORS and NOTIFY_ASSIGNED_WORKERS (what BUG-0019 made escalations reach). On edit the form rebuilt the actions from its checkboxes, so saving any change — even the description — removed those two actions from the rule and its escalation. The rule list showed them as raw codes. Found by the 2026-10 product and architecture review (PAR-10/51).
- **Root cause:** The form had no checkbox for two action types the API validates, and saved only what it had checkboxes for.
- **Expected behavior:** Every action type the API accepts has a checkbox in both action lists, is loaded on edit and saved back; the list labels them.
- **Broken behavior:** After an edit the rule had only NOTIFY_ADMINS; the escalation action was gone.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Create a rule (API) with NOTIFY_ASSIGNED_SUPERVISORS and an escalation NOTIFY_ASSIGNED_WORKERS.
2. In admin-alerts, Edit the rule, change its description, save.
3. Broken: both actions are gone. Fixed: kept. Browser test: e2e/tests/forms.spec.js (BUG-0043).

## BUG-0044 — Tickets raised by an alert rule were unassigned, had no SLA deadline, no audit row, and nobody was told

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** ticket-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/06)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** An alert rule's CREATE_TICKET action (directly or on escalation) created a bare ticket: no assignee (so no supervisor saw it), no slaDeadlineAt, no AuditLog row, no notification — unlike every ticket staff raise. The action's priority was never checked, so a rule saved with an unknown priority failed at the moment it fired. Found by the 2026-10 product and architecture review (PAR-10/06).
- **Root cause:** automation.js created the ticket with a bare prisma.ticket.create; alerts.js accepted any string as a ticket priority.
- **Expected behavior:** The ticket is assigned to the supervisor covering the location, has an SLA deadline, is audited (ticket_created_by_alert) and the assignee is notified; rule saves refuse an unknown priority (400).
- **Broken behavior:** assignedToId and slaDeadlineAt null; no audit row; a rule with priority "SUPER" saved (201).
- **Scenario dependencies:** —
- **Regression test:** `test/integration/alert-escalation.test.js`

**Reproduction steps:**

1. Create a rule on TICKET_HIGH_PRIORITY whose action is CREATE_TICKET, at a location a supervisor covers.
2. Raise a HIGH ticket there so the rule fires.
3. Broken: the [Auto] ticket has no assignee. Fixed: the covering supervisor holds it.

## BUG-0045 — Missed-inspection alerts: the night shift was checked during the night, and a second shift or a second rule never alerted

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** notification
- **Origin:** Product and architecture review 2026-10 (PAR-10/22)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** checkMissedInspections checked the NIGHT shift (22:00–06:00) from 22:00 to 06:00 — while it was running — so a "missed night inspection" fired minutes after the shift began, and after midnight a round done at 23:00 did not count (only today's inspections were read); nothing ran once the shift was over. fireAlert deduplicated on trigger + entity + day only, so a room that missed the morning and the afternoon got one alert, and of two rules on the same trigger only the first ever fired. Found by the 2026-10 product and architecture review (PAR-10/22) — the cross-rule part while fixing it.
- **Root cause:** The NIGHT skip condition was inverted and its window was the calendar day; the dedup key had neither the rule nor the shift.
- **Expected behavior:** A shift is checked after it ends (NIGHT: from 06:00, against inspections since 22:00 the evening before); one alert per rule, entity, shift and day.
- **Broken behavior:** A NIGHT alert at 22:30; no NIGHT alert at 07:00; one alert for two missed shifts; the second rule silent.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/missed-inspection.test.js`

**Reproduction steps:**

1. Create two INSPECTION_MISSED rules and a room with no inspections.
2. Run the scheduled checks at 23:00 and at 07:00 the next day (test/integration/missed-inspection.test.js mocks the clock).
3. Broken: one alert, for the first rule, at 23:00 — partly the night shift. Fixed: morning and afternoon at 23:00 for each rule; night at 07:00.

## BUG-0046 — Token verification accepted any HMAC algorithm, not just the HS256 the app signs

- **Severity:** LOW · **Status:** FIXED · **Module:** ele · **Category:** data-exposure
- **Origin:** Production readiness audit 2026-07 (L3); product and architecture review 2026-10 (PAR-10/35)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** All four jwt.verify sites (middleware/auth.js, worker-auth.js, images.js, the worker notification stream) passed no algorithms option, so jsonwebtoken accepted HS256, HS384 and HS512 for the shared secret. Not exploitable with one symmetric secret, but the allow-list is standard defence in depth (OWASP ASVS V9) and was open as PRA-07 L3. Found by the 2026-10 product and architecture review (PAR-10/35).
- **Root cause:** jwt.verify(token, secret) without { algorithms }.
- **Expected behavior:** Every verify pins { algorithms: ['HS256'] } (JWT_VERIFY_OPTIONS); a token signed otherwise answers 401.
- **Broken behavior:** An HS512-signed token for a real user answered 200 on /api/auth/me.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/jwt-algorithms.test.js`

**Reproduction steps:**

1. Sign { userId, orgId, role } with JWT_SECRET using HS512.
2. GET /api/auth/me with it.
3. Broken: 200. Fixed: 401.

## BUG-0047 — The pages re-sent a submission after a network error, so one tap could create two complaints or tickets

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** resilience
- **Origin:** Product and architecture review 2026-10 (PAR-10/54)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** public/js/app.js _doFetch retried every request up to three times when fetch failed with a network error — POST, PATCH and DELETE included. On a weak campus or mobile connection the request can reach the server and only the response be lost; the retry then submitted the same complaint, ticket, inspection or edit again. Found by the 2026-10 product and architecture review (PAR-10/54).
- **Root cause:** The retry loop did not distinguish idempotent requests from submissions.
- **Expected behavior:** Only GET/HEAD are retried after a network error; a submission fails once with the "Network error" message. A 503 (the circuit breaker refused before doing any work) is still retried.
- **Broken behavior:** A POST whose first attempt failed on the network was sent again.
- **Scenario dependencies:** —
- **Regression test:** `test/public-escaping.test.js`

**Reproduction steps:**

1. Load app.js with a fetch that fails once with a network error, then answers.
2. App.apiFetch(path, { method: "POST" }).
3. Broken: two POSTs reach fetch. Fixed: one, and the call rejects.

## BUG-0048 — Row actions the server refused (delete a rule, acknowledge an alert, flag an inspection) said nothing

- **Severity:** LOW · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** Product and architecture review 2026-10 (PAR-10/53)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** Several admin row actions only acted when the request succeeded: on a 4xx/5xx — for example a rule or alert another admin had just removed — the page showed no message and the row stayed as if nothing happened. App.apiFetch returns such responses to the caller without a message. Found by the 2026-10 product and architecture review (PAR-10/53).
- **Root cause:** The handlers had no else branch for a refused request.
- **Expected behavior:** A refused row action shows the server's error message (App.toastFailure).
- **Broken behavior:** Nothing visible happened.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Open admin-alerts; in another session delete one of the listed rules.
2. Press Delete on that rule.
3. Broken: nothing. Fixed: "Rule not found". Browser test: e2e/tests/forms.spec.js (BUG-0048).

## BUG-0049 — An asset purchase cost of 0 was stored as "unknown"

- **Severity:** LOW · **Status:** FIXED · **Module:** asset · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/52)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** routes/assets.js stored `data.purchaseCost || null` on create and edit, so a cost of 0 — a donated or free asset — became null. Found by the 2026-10 product and architecture review (PAR-10/52).
- **Root cause:** `|| null` treats 0 as missing; `?? null` keeps it.
- **Expected behavior:** purchaseCost 0 is stored as 0; null still clears it.
- **Broken behavior:** purchaseCost null after saving 0.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/admin-forms-api.test.js`

**Reproduction steps:**

1. POST /api/assets with purchaseCost: 0.
2. Read the asset.
3. Broken: purchaseCost null. Fixed: 0.

## BUG-0050 — An electrician was rung for a ticket under a deactivated location that their app would not open

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** worker-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/50)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** A location can be deactivated while its children stay active (DELETE /locations/:id?force=true), and those children still take complaints. getAssignedWorkerIds walked UP through the inactive location and rang the electrician covering the building, but getLocationDescendants — the electrician app's coverage — walked DOWN only through active locations, so the app answered 404. Found by the 2026-10 product and architecture review (PAR-10/50).
- **Root cause:** The descendant walk filtered "isActive" = true; the ancestor walk did not.
- **Expected behavior:** The electrician a ticket rings can open it: both walks follow the same tree, through deactivated locations.
- **Broken behavior:** GET /api/worker/tickets/:id answered 404 for a ticket the electrician was notified about.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/worker-coverage-inactive.test.js`

**Reproduction steps:**

1. Building ← Floor ← Room; an electrician assigned to the building with coverChildren.
2. Deactivate the floor with force=true; raise a complaint in the room.
3. Open the ticket in the electrician app. Broken: 404. Fixed: 200.

## BUG-0051 — No sign-in page let anyone ask for a password or PIN reset; the super-admin "Run one-time setup" link was dead

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** account-recovery
- **Origin:** Product and architecture review 2026-10 (PAR-10/26)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** POST /auth/forgot-password and /auth/worker-forgot-pin had no caller in the app: no sign-in page had a "Forgot password / PIN" link, and the reset pages, opened without a link, said "request a new reset from the sign-in page", which could not be done. The super-admin sign-in page's "Run one-time setup" linked to /superadmin-setup, which does not exist. Found by the 2026-10 product and architecture review (PAR-10/26).
- **Root cause:** The request side of the reset flow was built as API only; the setup hint pointed at a page that was never written.
- **Expected behavior:** Each sign-in page links to a request form (the reset page without a token); the super-admin hint says the operator does the one-time setup and links nowhere (the setup page was removed on purpose, b9d9d8a).
- **Broken behavior:** No way to request a reset from the app; the setup link opened a page that does not exist.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Open /<org>/ele/admin-login (or the supervisor or electrician sign-in page).
2. Broken: no "Forgot password?" link; /reset-password without a token is a dead end. Fixed: link → email → "If an account exists…".
3. Browser test: e2e/tests/forms.spec.js (BUG-0051).

## BUG-0052 — Nobody could change their own password or PIN while signed in

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** account-recovery
- **Origin:** Product and architecture review 2026-10 (PAR-10/26)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** PATCH /auth/password (admin, supervisor) and PATCH /auth/worker-pin (electrician) had no screen in the app; the only way to a new password or PIN was an administrator, or a reset email. Found by the 2026-10 product and architecture review (PAR-10/26).
- **Root cause:** The endpoints were built without a screen.
- **Expected behavior:** The profile modal has "Change password" (staff) or "Change PIN" (electrician); the session goes on with the token the server returns; a wrong current PIN does not sign the electrician out.
- **Broken behavior:** No way to change a password or PIN from the app.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Sign in; open the user menu → Profile.
2. Broken: only Close. Fixed: Change password / Change PIN → current, new, confirm → "changed".
3. Browser test: e2e/tests/forms.spec.js (BUG-0052).

## BUG-0053 — The profile of an electrician said "Admin"

- **Severity:** LOW · **Status:** FIXED · **Module:** ele · **Category:** ui
- **Origin:** Found while fixing BUG-0052 (2026-10-25)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** public/js/app.js _renderProfileModal mapped SUPER_ADMIN and SUPERVISOR to their labels and everything else to "Admin", so an electrician's profile (role ELECTRICIAN) showed an Admin badge. Found while fixing BUG-0052.
- **Root cause:** A two-way ternary with "Admin" as the default.
- **Expected behavior:** The badge reads Electrician for an electrician.
- **Broken behavior:** The badge read Admin.
- **Scenario dependencies:** —
- **Regression test:** `e2e/tests/forms.spec.js`

**Reproduction steps:**

1. Sign in as an electrician; user menu → Profile.
2. Broken: "Admin". Fixed: "Electrician". Browser test: e2e/tests/forms.spec.js (BUG-0053).

## BUG-0054 — On a shared phone, an inspection saved offline was sent in as whoever else was signed in

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** supervisor-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/49)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** public/js/app.js replayed the offline queue, from any page that came back online, with the first token found (admin, super admin, supervisor, electrician — in that order). On a device where a supervisor and an admin were both signed in, a supervisor's inspection saved offline was submitted with the admin's session and recorded as the admin's. App.imgUrl put the first token found into photo URLs the same way. Found by the 2026-10 product and architecture review (PAR-10/49).
- **Root cause:** The replay and imgUrl had no notion of which role a request belonged to.
- **Expected behavior:** A queued entry records its role and is replayed only with that role's token (it waits if that role is signed out); photo URLs carry the page's own session.
- **Broken behavior:** The inspection was recorded under the admin; it could also be sent with a session of another organization.
- **Scenario dependencies:** —
- **Regression test:** `test/shared-device-sessions.test.js`

**Reproduction steps:**

1. On one browser, sign in as an admin and as a supervisor.
2. Go offline on supervisor-electrical, submit an inspection (it is saved), then come back online on an admin page.
3. Broken: the inspection is submitted with the admin's token. Fixed: with the supervisor's. Test: test/shared-device-sessions.test.js.

## BUG-0055 — Date filters started each day at 05:30 in India (UTC midnight), and pages took "today" from UTC

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/07)
- **Introduced:** pre-audit · **Fixed:** 2026-10-25
- **Description:** The ticket, audit-log, alert, asset-event, asset-failure, inspection and analytics filters parsed a date-only `from` as UTC midnight — 05:30 IST — so the first 5.5 hours of a range were left out; the ticket and audit-log filters ended `to` at 05:29 the next morning, and three analytics endpoints at 05:30 on the last day. Admin pages built "today" and their preset ranges with toISOString(), the UTC date, which is yesterday between 00:00 and 05:30 IST. Found by the 2026-10 product and architecture review (PAR-10/07).
- **Root cause:** new Date("YYYY-MM-DD") is UTC midnight; the server and its users are in IST. Each route parsed its own way.
- **Expected behavior:** One rule (lib/dates.js dayRange): a date-only value is the local day, 00:00 to 23:59:59.999 in the server's TZ. Pages use App.localDate().
- **Broken behavior:** A ticket raised at 01:00 IST was missing from that day's list, and showed in the previous day's.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/date-filters-local-day.test.js`

**Reproduction steps:**

1. With TZ=Asia/Kolkata, raise a ticket at 01:00 IST.
2. GET /api/tickets?from=<that day>&to=<that day>. Broken: missing (and listed under the day before). Fixed: listed.
3. Regression: test/integration/date-filters-local-day.test.js (runs in Asia/Kolkata).

## BUG-0056 — Analytics charts counted inspections between midnight and 05:30 under the day before

- **Severity:** MEDIUM · **Status:** FIXED · **Module:** ele · **Category:** admin-workflow
- **Origin:** Product and architecture review 2026-10 (PAR-10/07)
- **Introduced:** pre-audit · **Fixed:** 2026-10-26
- **Description:** The analytics trends, report, room heatmap and location history, and the super-admin activity and AI-usage charts, grouped by UTC day: SQL DATE("inspectedAt") on a column holding UTC, and toISOString() date keys. In India an inspection between 00:00 and 05:30 counted on the previous day, and the report's day labels were shifted by one (its first label before the range, its last day missing). Found by the 2026-10 product and architecture review (PAR-10/07).
- **Root cause:** Day keys taken in UTC while the server and its users are in IST.
- **Expected behavior:** Every chart groups by the local day: localDateKey() in JS, DATE(col AT TIME ZONE 'UTC' AT TIME ZONE <server zone>) in SQL.
- **Broken behavior:** An inspection at 01:00 counted on the day before; the report period started a day early.
- **Scenario dependencies:** —
- **Regression test:** `test/integration/analytics-local-days.test.js`

**Reproduction steps:**

1. With TZ=Asia/Kolkata, record inspections at 01:00 and 23:30 on one day.
2. GET /api/analytics/report?from=<day>&to=<day>. Broken: trend keyed by the day before. Fixed: [{ date: <day>, count: 2 }].
3. Regression: test/integration/analytics-local-days.test.js (runs in Asia/Kolkata).

