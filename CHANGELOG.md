# Changelog

All notable changes to this project are recorded here. This file was established by
`[WP16]` (Documentation & Release Process Hygiene) as an ongoing convention — see
`docs/ENGINEERING_CHARTER.md` §18 for how this differs from user-facing Release Notes:
**this file** gets an entry for every merged change, internal refactors and tooling
changes included; **Release Notes** are reserved for changes a guest, electrician,
supervisor, admin, or superadmin would actually notice, written in their language.

Entries are grouped by date and tagged with the Engineering Execution Plan Work Package
(`[WPn]`) that produced them, mirroring `docs/ENGINEERING_CHARTER.md`'s own Amendment Log
— that document explains *why* each change was made and the durable rule it established;
this file is the terser, chronological "what changed and when."

This changelog currently starts at `[WP7]` — the earliest work in the current
production-hardening pass this project has a verified, dated record for (via the Charter's
own Amendment Log). `apps/api/package.json` currently declares version `1.0.0`; nothing
has been git-tagged yet, so everything below is grouped under **Unreleased**.

## Unreleased

Complete and merged into the working tree as of this writing, pending its next deploy —
see `docs/DEPLOYMENT.md` for how a change reaches production.

### 2026-10-25 (PAR-10 fixes: security and data exposure)

- **`[BUG-0027]` The electrician API returned the guest's review token and personal data**
  (PAR-10/14). Every electrician ticket route (list, detail, pool, my work, pickup, resolve)
  read tickets with a bare `include`, so the JSON carried every column: the guest's secret
  review token — enough for the electrician who did the work to "confirm as the resident" —
  and their name, phone, IP hash, user agent and risk score. `worker-auth.js` now returns one
  explicit field allow-list (`WORKER_TICKET_SELECT`) holding exactly what the electrician app
  reads. Not visible to users. No data migration: a pending review link expires 30 minutes
  after it is issued, so any token already exposed is short-lived.
- **`[BUG-0028]` Stored XSS through names in attributes and inline handlers** (PAR-10/29).
  `App.esc` (`textContent` → `innerHTML`) escaped `& < >` but not quotes. 42 places put its
  output inside quoted attributes with names an org admin types, so a location named
  `x" onmouseover="…` gained a live handler. 15 inline `onclick` handlers passed names as
  `esc(name).replace(/'/g, "\\'")`, which a backslash or a double quote defeats. The CSP
  allows inline handlers, and a super-admin who enters the org opens these pages.
  - `App.esc` now escapes `& < > " '`.
  - A new `App.escJs` escapes for JS first and HTML second, and every handler argument uses
    it.
  - One `textContent` assignment no longer double-escapes.
  - The rule is in `docs/architecture/frontend.md`.
  - Tests: `test/public-escaping.test.js` (the helpers, run in a sandbox, plus a static check
    that the old idiom is gone) and a browser test in `e2e/tests/forms.spec.js`, red on the
    old pages.
  - Names that contain quotes now show in full in tooltips; nothing else is visible to users.
  - CSP `'unsafe-inline'` (PRA-07 M1) is unchanged.
- **`[BUG-0029]` `npm test` passed when a test file's `describe()` threw while collecting its
  tests.** Node 24 prints that suite as failed, but exits 0 and counts `fail 0`, so none of its
  tests ran and CI stayed green. Found while writing the BUG-0028 test.
  - `scripts/report-tests.js` now reads the failure from the JUnit XML and the events stream,
    makes the run exit 1, and names the suite.
  - New real Node 24 fixture: `test/fixtures/junit/node24-suite-throws.*`.
  - `apps/api/test/README.md` documents the rule.
  - No test in the current suite was affected.
- **`[BUG-0030]` Supervisors' Aadhaar numbers and blood groups were stored in plain text and
  copied into audit logs** (PAR-10/15). Only electricians' values were encrypted; the
  supervisor routes wrote them as typed, and each edit recorded the old and new values in
  AuditLog as `{ from, to }`. That broke Charter §6, and `data-model.md` claimed otherwise.
  - `lib/crypto.js` now has generic `encryptPII` / `decryptPII` (the worker helpers are
    aliases) and `isEncrypted`.
  - `supervisors.js` encrypts on create and update and decrypts for the admin.
  - The audit diff runs on decrypted values and records `{ changed: true }` for these two
    fields.
  - A row saved before the fix still reads correctly and is encrypted when next saved.
- **Deployment step (owner):** `scripts/migrate-user-pii.js` encrypts the older rows and strips
  the values from old supervisor audit rows. It runs as a dry run by default; `--apply` writes.
  Run it after a backup (`docs/DEPLOYMENT.md`). Not visible to users.
- **`[BUG-0031]` Worker detail, create and update responses carried the PIN hash and a pending
  PIN-reset token** (PAR-10/16). This affected the org-admin and super-admin routes. They now
  return `WORKER_PROFILE_SELECT` (`lib/security.js`): the profile, and no credential
  material. Not visible to users.
- **`[BUG-0032]` An org admin's "run checks / run escalations" ran every tenant's jobs,
  outside the scheduler lock** (PAR-10/01, PAR-10/42).
  - What happened: `POST /api/alerts/run-checks` and `/run-escalations` started the
    platform-wide scheduled checks and escalations. A test showed org A's call escalating
    org B's overdue alert. The manual run also bypassed the advisory lock, so next to the
    5-minute scheduled run one alert could escalate twice. The escalation scan also
    escalated alerts of suspended and deleted orgs.
  - Now: both jobs take `{ orgId }`, and the routes run the caller's org only, awaited
    under the job's own lock. They answer `409` while the scheduled run holds that lock,
    and `400` for a super-admin who has not entered an org. Escalations skip orgs that are
    not `ACTIVE`.
  - Tests: `alert-escalation.test.js` and the BUG-0019 scenario now run escalations for
    their own org, so parallel test files no longer escalate each other's alerts.
  - Documented in `docs/architecture/resilience.md`. No page calls these routes.
- **`[BUG-0033]` A proof photo uploaded late in an old ticket's life was deleted the next
  night** (PAR-10/18).
  - What happened: the daily image cleanup counted a ticket's proof photo from the ticket's
    creation, so finishing work on a ticket more than 30 days old lost the new photo before
    anyone verified it.
  - Now: each photo is kept for 30 days from when it was taken — the complaint photo from the
    ticket's creation, the proof photo from `resolvedAt` (`expiredTicketPhotos` in
    `services/cleanup.js`).
  - The 30-day period itself is unchanged; the privacy page's "7 days" is PAR-10/28.
    Documented in `docs/architecture/resilience.md`.
- **`[BUG-0034]` Password and PIN reset tokens were stored as issued** (PAR-10/21).
  - What happened: the database value itself reset the account. Anyone who could read the
    database or a backup could take over any account with a pending reset.
  - Now: only the SHA-256 digest is stored and looked up (`hashResetToken` in
    `lib/security.js`); the e-mailed link is unchanged.
  - Docs: Charter §6 recovery rule amended (Amendment Log 2026-10-25); `data-model.md`
    updated.
  - Tests: `account-recovery.test.js` and the J8 phone journey seed a known token instead of
    reading it back.
  - **On deploy:** reset links issued in the hour before the deploy stop working; the person
    requests a new one. Not otherwise visible to users.
- **`[BUG-0035]` Permanently deleting an electrician who was on a duty roster failed with a
  500; attendance history was silently erased** (PAR-10/20).
  - The [WP17] guard counted only inspections. Duty rosters reference the worker with
    `RESTRICT` (hence the 500), and attendance records and resolved-ticket links cascade.
  - `DELETE /api/workers/:id/permanent` now refuses with `409` and lists every history
    (inspections, duty rosters, attendance records, resolved tickets).
  - The admin sees the reason instead of an error. Documented in `data-model.md`, which also
    notes the roster `RESTRICT` as a hazard for a future org purge.
- **`[BUG-0036]` `npm test` passed when a suite's `after()` hook threw** — for example a
  cleanup that left test data behind.
  - Node 24 exits 0 with `fail 0`, and only the events stream records the failure.
  - `scripts/report-tests.js` now fails the run for any suite-level `hookFailed`, as BUG-0029
    did for a throwing `describe()`.
  - Found when the BUG-0035 test's roster made the org cleanup fail while the run stayed
    green.
  - New fixture: `test/fixtures/junit/node24-after-throws.*`.
- **User-visible (Release Notes, new [`docs/releases/next-draft.md`](docs/releases/next-draft.md)
  for changes since v1.0.0):** a deactivated supervisor's open tickets are handed over.
- **`[BUG-0037]` A deactivated or moved supervisor kept their open tickets, where no one else
  could see them** (PAR-10/09).
  - Applies to all three paths: `PATCH /api/supervisors/:id` with `isActive: false`,
    `DELETE /api/supervisors/:id`, and the super-admin user edit (deactivate, or move to
    another org).
  - Each open ticket (active or pending verification) goes to the nearest active supervisor
    covering its location — the rule a new complaint uses — or back to the pool. It happens
    in the same transaction, with one `ticket_reassigned` audit row per ticket, and the new
    assignee is notified (`planTicketHandover` / `applyTicketHandover` /
    `notifyTicketHandover` in `services/assignment-resolver.js`).
  - A move also deletes the user's coverage in the old org, so new complaints there stop
    reaching someone in another tenant.
  - The admin page's message says how many tickets moved. Finished tickets keep their
    assignee.
- **`[BUG-0038]` Two people acting on one ticket at once both "succeeded" — the last write
  won** (PAR-10/05).
  - What happened: every transition read, checked, then updated by id alone. A test showed
    verify and reopen both answering 200 on one ticket, a double verify both landing (two
    audit rows), and two supervisors "picking up" the same ticket.
  - Now: each lifecycle route writes through `updateTicketIfUnchanged`
    (`services/ticket-status.js`). That covers the staff accept, pick up, resolve, verify and
    reopen; the electrician's pick up and resolve; and the guest's confirm and reject. The
    update applies only if the status is still the one checked; the loser answers `409`
    ("changed by someone else just now — reload").
  - Electricians may still join one ticket at the same moment.
  - A proof photo uploaded by a losing resolve is deleted.
  - The admin's generic PATCH stays an explicit override.
  - Documented in `data-model.md`.
- **`[BUG-0039]` Analytics labelled every electrician and supervisor bar "undefined"; the
  dashboard's "Today's Inspection Log" was always empty** (PAR-10/27).
  - Both pages read field names the APIs do not send: `records` and `inspections` swapped.
  - This was the cause of the 17 phone-explorer failures in full local e2e runs (also on
    `origin/main`). They appear only once other tests have added inspections.
  - Browser test: `e2e/tests/ui-fixes.spec.js`.
- **User-visible (Release Notes):** the analytics performance bars show counts, and the
  dashboard lists today's inspections.
- **`[BUG-0040]` Asset, failure and inspection photos were broken images in the admin detail
  views** (PAR-10/24).
  - `admin-assets`, `admin-failures` and `admin-electrical` used raw `/images/...` paths;
    photos are served only through `/api/images/...` with the viewer's token. All three now
    go through `App.imgUrl`, including the inspection lightbox.
  - Browser test in `e2e/tests/ui-fixes.spec.js` with a real stored photo.
  - The BUG-0039 browser test now uses the explorer org's cached sign-in. It had used fresh
    admins, which hit the per-IP login limit (429) in a full run.
- **User-visible (Release Notes):** photos attached to assets, failures and inspections show
  in the admin pages.
- **`[BUG-0041]` The guest review page could not show the proof photo the resident was asked
  to confirm** (PAR-10/23).
  - What happened: the review response gave the raw `/images/...` path, which needs a staff
    or electrician token.
  - New route `GET /api/public/review/:token/photo`. It serves only that ticket's proof photo,
    only while its review is open and in date, and is rate-limited.
  - The review response now gives `photoUrl` instead of the storage path. `review.html` uses
    it.
  - The token in the path stays out of logs: the app logs the route template, and Caddy
    already redacts `/review/...`.
  - Route index regenerated. J5 now checks that the photo loads.
- **User-visible (Release Notes):** residents see the proof photo on the review page.
- **`[BUG-0042]` A ticket the guest rejected was open again but kept its resolution and
  verification times** (PAR-10/55).
  - Analytics counts any ticket with `resolvedAt` as resolved, so a reopened ticket counted
    as resolved with a stale time.
  - The REJECT now clears `resolvedAt`, `verifiedAt`, `verifiedById` and `verifyNote`, as
    every other reopen does ([WP10]). The photo and the guest's note stay (BUG-0026).
- **`[BUG-0043]` Editing an alert rule silently dropped its "notify the location's supervisors
  / electricians" actions** (PAR-10/51).
  - The form offered only three of the five action types the API accepts, and saving
    rebuilt the actions from its checkboxes.
  - Both lists (actions and escalation actions) now offer, load and save all of them, and the
    rule list labels them.
- **User-visible (Release Notes):** the alert-rule form can send alerts to the supervisors and
  electricians of the location concerned.
- **`[BUG-0044]` Tickets raised by an alert rule were unassigned, had no SLA deadline and no
  audit row, and nobody was told** (PAR-10/06).
  - The CREATE_TICKET action now assigns the supervisor covering the location, sets the SLA
    deadline, writes `ticket_created_by_alert`, and notifies the assignee.
  - It still does not raise `TICKET_HIGH_PRIORITY`, so a rule cannot loop on its own ticket.
  - Rule saves refuse a ticket priority outside LOW, NORMAL, HIGH and URGENT (`400`). Before,
    such a rule saved and then failed when it fired.
  - The SLA table moved to `services/ticket-status.js` (`getSlaDeadline`), shared by both
    paths.
- **User-visible (Release Notes):** tickets created by alert rules go to the location's
  supervisor.
- **`[BUG-0045]` Missed-inspection alerts were mistimed and deduplicated too broadly**
  (PAR-10/22).
  - The NIGHT shift (22:00–06:00) was checked while it was running, so an alert fired minutes
    after it began. After midnight only today's inspections counted, so a round done at 23:00
    didn't. Nothing was checked once the shift ended.
  - `fireAlert` deduplicated on trigger + entity + day. So a room that missed two rounds got
    one alert, and of two rules on the same trigger only the first ever fired.
  - Now each shift is checked after it ends. NIGHT is checked from 06:00, against
    inspections since 22:00 the evening before.
  - The dedup key now includes the rule and the shift. On the day of the deploy, an alert
    raised that day under the old key may be raised once more.
  - Shown by `test/integration/missed-inspection.test.js`, which mocks only `Date`.
    `docs/architecture/resilience.md` updated.
- **User-visible (Release Notes):** missed-inspection alerts arrive after each shift; none
  arrive at the start of the night shift.
- **`[BUG-0046]` Token verification accepted any HMAC algorithm** (PRA-07 L3, PAR-10/35).
  - All four `jwt.verify` sites now pass `JWT_VERIFY_OPTIONS` (`{ algorithms: ['HS256'] }`,
    `lib/security.js`): the staff API, the electrician API, the image proxy and the
    electrician's live stream.
  - A token signed HS384 or HS512 with the same secret answers 401.
  - `auth-and-tenancy.md` updated. Not visible to users: the app signs HS256 only.
- **`[BUG-0047]` The pages re-sent a submission after a network error** (PAR-10/54).
  - `public/js/app.js` `_doFetch` retried every request three times on a network error,
    POST, PATCH and DELETE included. On a weak connection, where the request had reached the
    server but the reply was lost, one tap could create two complaints, tickets or
    inspections.
  - Now only GET and HEAD are retried after a network error. A submission fails once, with
    the "Network error" message, and the person can try again knowingly.
  - A 503 (the circuit breaker refused before doing anything) is still retried.
  - Documented in `docs/architecture/frontend.md`.
- **`[BUG-0048]` Row actions the server refused said nothing** (PAR-10/53).
  - Deleting an alert rule, acknowledging one or all alerts, and flagging or unflagging an
    inspection acted only on success. When the server refused, for example because another
    admin had just removed the item, the page stayed silent.
  - They now show the server's message through a new `App.toastFailure`.
  - The asset page's `deleteAsset` got the same treatment, although no button calls it.
    Admins decommission an asset through the edit form.
- **`[BUG-0049]` An asset purchase cost of 0 was stored as "unknown"** (PAR-10/52). `|| null`
  became `?? null` on create and edit.
- **User-visible (Release Notes):** refused actions say why; a cost of 0 is kept.
- **`[BUG-0050]` An electrician could be rung for a ticket they could not open** (PAR-10/50).
  - An admin can deactivate a floor and keep the rooms under it active
    (`DELETE /locations/:id?force=true`), and those rooms still take complaints.
  - The ring (`getAssignedWorkerIds`) walked up through the inactive floor and reached the
    electrician covering the building. The electrician app's coverage
    (`getLocationDescendants`) walked down only through active locations, so it answered
    404 for that ticket. It did the same for open tickets left at the deactivated floor.
  - The descendant walk now passes through deactivated locations and includes them, as the
    ancestor walk does. Coverage still ends at the electrician's own subtree and org.
  - Documented in `docs/architecture/data-model.md`.
- **User-visible (Release Notes):** electricians can open tickets under a deactivated floor.

### 2026-10-24 (product and architecture review — documentation only)

- **Documentation only; no code, schema, dependency, workflow or setting changed.** Not
  user-visible, so no Release Notes entry.
- New `docs/history/product-architecture-review-2026-10.md` (findings `PAR-10/1`–`PAR-10/55`).
  It is a dated review of how the product fits real colleges and hostels and covers:
  - the inventory and role matrix;
  - the ticket lifecycle;
  - post-resolution options;
  - modules versus feature settings;
  - risks and scenarios;
  - QA and release status;
  - a P0–P3 backlog with an implementation sequence;
  - external research;
  - decisions for the owner.
- New ADR drafts, both `Proposed`:
  - [`docs/adr/0010-configurable-post-resolution-workflow.md`](docs/adr/0010-configurable-post-resolution-workflow.md);
  - [`docs/adr/0011-tenant-feature-settings.md`](docs/adr/0011-tenant-feature-settings.md).
- Indexed in `docs/adr/README.md` and `docs/README.md`.

### 2026-10-20 (bug hunt: every button and form)

- **User-visible (Release Notes):** cleared fields in the asset / location / alert-rule edit
  forms are saved; supervisors see the confirmation after an asset event or failure; a new
  roster pre-selects the covering electricians; the Scan page no longer opens the camera on
  iPhones; super-admins can create an organization without an email.
- **`[BUG-0021]` Edit forms ignored cleared fields.** `admin-assets.html`,
  `admin-locations.html` and `admin-alerts.html` sent `undefined` for an emptied field (and
  dropped "None (Top Level)"), so the server kept the old value. On edit they now send `''` /
  `null`; `assets.js` accepts `null` for `maintenanceCycleDays` and `purchaseCost`.
- **`[BUG-0022]` The Scan pages opened the camera with nothing to read it.** Both
  (`electrician-scan`, `supervisor-scan`) now check BarcodeDetector + `qr_code` support before
  `getUserMedia`; without it they say so and focus the code field.
- **`[BUG-0023]` Creating an organization required an email.** The create schema refused the
  `''` the form sends; it now accepts it (stored as null), as edit already did.
- **`[BUG-0024]` Blank page after a supervisor's asset event or failure.** `showSuccess()` set
  `display = ''` on an element that is `display:none` in the stylesheet; it sets `block`.
- **`[BUG-0025]` A new roster suggested no electrician.** `GET /duty-roster/suggested-workers`
  counted direct assignments only; it now uses `getAssignedWorkerIds` (direct + ancestors with
  coverChildren), like the complaint ring.
- **Tests:**
  - `e2e/tests/forms.spec.js` (13, desktop only): every button and form the explorer does not
    press (see `e2e/README.md`). 7 of them were red on `main` — exactly the BUG-0021…0025
    tests — and all 13 are green.
  - `test/integration/admin-forms-api.test.js` (3) and `superadmin-org-form.test.js` (2): the
    API side of BUG-0021, BUG-0023 and BUG-0025, and tenant scoping of the roster suggestion.
  - Registry BUG-0021…BUG-0025, red on `main` first.
- **Docs:** COVERAGE_MATRIX (the forms row, duty-roster, the camera QR scan note), `e2e/README.md`.

### 2026-10-20 (bug hunt: authorization sweep and the escalation scheduler)

- **User-visible (Release Notes):** alert escalations now reach the supervisors and
  electricians responsible for the location, and can raise their ticket.
- **`[BUG-0019]` Escalations reached no one at the location.**
  - **Cause:** `runEscalationChecks` reads the location from `alert.metadata.locationId`, but
    `fireAlert` stored `data.metadata || null` and no event payload has `metadata` (they carry
    `locationId` at the top level). NOTIFY_ASSIGNED_SUPERVISORS / _WORKERS and CREATE_TICKET
    returned early on every escalation.
  - **Fix:** `fireAlert` records `{ locationId, module }` when the payload has a location.
    Alerts raised before this change still have no location (no data migration).
- **`[BUG-0020]` A guest complaint could be filed in a disabled module.**
  `POST /api/public/complaint` checked the module code against the platform's list only; it
  now also requires the org to have it enabled (400), as `POST /api/tickets` already did.
- **Tests:**
  - `test/integration/alert-escalation.test.js` (4): ESCALATION_CHECKS on back-dated alerts
    raised through `POST /api/tickets` — timing, the second window, `maxEscalations`,
    acknowledged alerts, inactive rules, recipients, CREATE_TICKET, tenant scoping.
  - `test/integration/authz-sweep.test.js` (5): all 37 id-taking mutating staff routes called
    by another org with a valid body (each answers 404 and changes nothing); role boundaries
    (electrician → staff 401, supervisor → admin 403, admin → super-admin 403); a suspended
    org; a disabled module; BUG-0020.
  - Registry BUG-0019, BUG-0020, both red on `main` first.
- **Docs:** COVERAGE_MATRIX: the `images.js` row (another org's image already answers 404,
  since F15), ESCALATION_CHECKS, W2 and the complaints module; `module-system.md` (tickets only
  in enabled modules).

### 2026-10-20 (bug hunt: the ticket lifecycle, every role)

- **User-visible (Release Notes):** electricians are told when their fix is verified or sent
  back (with the reason), and when a guest rejects it — the ticket is back in their pool; a
  reopened public complaint can no longer be closed by its old guest review link; a guest can
  review the next fix after rejecting one.
- **`[BUG-0015]` An electrician could re-resolve a verified ticket.**
  - **Cause:** `POST /worker/tickets/:id/resolve` refused only CLOSED/CANCELLED, so a
    RESOLVED (verified) or RESOLVED_PENDING_VERIFY ticket went back to pending verification.
  - **Fix:** only OPEN, ACKNOWLEDGED, ASSIGNED, IN_PROGRESS and ON_HOLD can be resolved (the
    statuses the app offers it for); anything else answers 400.
- **`[BUG-0016]` A reopened public ticket could be closed by its old review.**
  - **Cause:** `PATCH /tickets/:id` back to an active status cleared the resolution but not the
    pending guest review; the old link still CONFIRMED (closed) it, and the lazy auto-close
    closed it once the window passed.
  - **Fix:** that PATCH withdraws a pending review (token, status, expiry), and
    `autoCloseExpiredReviews` only closes RESOLVED tickets.
- **`[BUG-0017]` No second guest review after a rejection.** Verify issued a review link only
  when the ticket had no token at all; after a rejection the spent token blocked it. It now
  issues a fresh one unless a review is pending.
- **`[BUG-0018]` The electrician was never told the outcome.** Verify and reopen notified only
  the admins. Both now notify the resolving electricians through `notify()` (`to.workerIds`):
  `ticket_verified`, and `ticket_reopened` with the supervisor's note. Clicking a
  `ticket_verified`, `ticket_reopened` or `ticket_review_rejected` notification now opens the
  tickets page (`public/js/app.js`), like the other ticket notifications.
- **`[BUG-0026]` A guest-rejected ticket was stuck for its electrician.** The guest's REJECT
  reopened the ticket but left the electrician connected (`resolvedWorkers`), so it was out of
  their pool and their app showed it "Done" with no Pick Up. It now disconnects them (as the
  supervisor's reopen does) and notifies them (`ticket_review_rejected`, with the guest's note);
  the photo, the notes and the guest's verdict stay on the ticket.
- **Tests:**
  - `test/integration/ticket-resolve-verify.test.js` (11): staff and electrician resolve with
    real photo uploads (`STORAGE_DRIVER=local`), verify, reopen and the guest review, for the
    admin, the assigned supervisor, another supervisor, another org, the electrician and the
    guest; it closes the COVERAGE_MATRIX gaps on `/resolve` and `/verify`.
  - `test/integration/public-complaint-chain.test.js` (3): the QR routes, a complaint with a
    photo, the hierarchy auto-assignment, and exactly who is notified (W1/W3 P1 gaps).
  - Journey J9 (`e2e/tests/journeys.spec.js`): reject with a reason → the electrician's bell →
    redo → verify → the bell.
  - Registry BUG-0015…BUG-0018 and BUG-0026. Each was red on `main` first.

### 2026-10-18 (UI fixes found by the tester)

- **User-visible (Release Notes):** every admin page has the same working menu. Analytics shows
  numbers instead of "undefined". Filters are announced by screen readers, and the "All
  modules" link is readable. Details in the Release Notes draft.
- **`[BUG-0012]` admin-analytics showed "undefined".**
  - **Cause:** the page read `summary.totalRecords` / `flaggedRecords` and
    `locationBreakdown[].cleaned`, names `GET /api/analytics/report` doesn't send.
  - **Fix:** it now uses `totalInspections` / `flaggedInspections` / `inspections`. Expected
    and Completion show "—" (the API sends no schedule data). Frontend only.
  - **Tests:** registry BUG-0012 compares the fields the page renders with the real API
    response; the explorer's new `rawValue` check catches any visible "undefined" or "NaN".
- **`[BUG-0013]` Admin pages without the shared admin shell.**
  - **The pages:**
    - assets, electrical and failures had an unstyled nav (links run together, F17's
      1030 px-wide phone page), `<main class="main-content">` (defined nowhere), and a Logout
      button with no handler;
    - predictions had no topbar at all;
    - alerts had no phone menu button.
  - **Fix:** the same topbar, menu button and container as the other admin pages.
  - **Tests:** registry BUG-0013 (every admin page has the shell); the explorer's new `nav`
    check (≥ 5 nav links; the link texts don't run together on desktop).
- **`[BUG-0014]` admin-alerts was always dark.**
  - **Fix:** the hard-coded `data-theme="dark"` is removed.
  - **Test:** registry BUG-0014.
- **`[F16]` 22 filter controls on 7 pages had no accessible name.** They now have `aria-label`.
- **`[F17]` Phone overflow on 3 admin pages:** fixed by BUG-0013.
- **`[F18]` "← All modules" on the module home was blue on blue** (contrast 1.0).
  - **Fix:** it is now `var(--primary-light)`.
  - **Test:** `e2e/tests/ui-fixes.spec.js` computes the WCAG ratio against every gradient stop.
    axe can't judge text on a gradient.
- **Explorer allow-list:** 10 entries → **0**. The removed entries are gone, not loosened.
- **Docs:** `e2e/README.md` (the `rawValue` and `nav` checks, empty allow-list),
  `COVERAGE_MATRIX` (F16, F17 resolved; F18), the bug registry doc, the Release Notes draft.

### 2026-10-18 (CI speed)

- **User-visible (Release Notes):** a deploy now interrupts the site for the restart only, about
  15 seconds instead of the whole image build.
- **`[CI]` e2e in 3 parallel shards, one combined report** (`.github/workflows/e2e.yml`,
  `e2e/merge.config.js`).
  - **Shards:** each `e2e shard i/3` has its own disposable database and runs
    `--shard=i/3 --reporter=blob`.
  - **The required job `e2e`** merges the blob reports with `playwright merge-reports`. The
    result is the same HTML, JUnit and `results.json`, so `summarize.js`, the contrast ratchet
    and the QA ingest are unchanged.
  - **Finer split:** `explorer.spec.js` and `visual-a11y.spec.js` are `mode: 'parallel'`, so
    the shards can split them; `workers` stays 1.
  - **Artifacts:** traces and new baselines from all shards are re-uploaded as the usual
    `e2e-traces` / `e2e-snapshots-linux`. Each shard contributes only the baselines it wrote.
  - **Browser cache:** the Playwright browser download is cached (`actions/cache@v5.0.5`).
- **`[CI]` The `e2e` check exists on every PR.**
  - **Before:** the `paths:` filter meant a docs-only PR never got the required check, so it
    could not merge.
  - **Now:** a first job compares the PR's files (`git diff`, no new action). When none is
    under `apps/api/**`, `e2e/**` or the workflow, `e2e` passes in seconds.
- **`[CI]` Lint & Test caches Prisma's engine binaries.** Setup was already about 35 s; the
  211 s is the API test suite itself, which already runs test files in parallel.
- **`[DEPLOY]` Build before stop.** The deploy script runs `docker compose build` while the old
  version serves, then `down` and `up -d`. A failed build (`set -e`) now leaves production
  running, where it used to fail after `down`. Everything else in the script is unchanged:
  env write, health wait, Caddy check, recorded SHA, smoke job.
- **Docs:** `e2e/README.md` (CI), `docs/testing/TESTING.md`, `docs/DEPLOYMENT.md`.
- **Charter §22:** the deployment documentation is triggered, and updated. No ADR is needed:
  the pipeline's shape (test → deploy → smoke) is unchanged.

### 2026-10-17 (QA-2 design coverage)

- **User-visible (Release Notes):** none; this is test tooling.
- **`[QA-2]` Visual baselines for every page.** `e2e/tests/visual-a11y.spec.js` takes its
  page list from the explorer's role map (the route table): 42 pages × desktop + Pixel 7 =
  84 page views, up from 20.
  - **The visual org** gets the assets module, a supervisor, a resolved ticket with a fixed
    review link, an asset with a failure and a default inspection template. Every fixture row
    is dated, and every page's clock is frozen, at one instant.
  - **The super-admin pages** use the seed's super-admin (cached login, so the run stays
    within 9 of the 10 logins per 15 minutes). The dashboard's organization list is
    answered with two fixed organizations.
  - **Determinism:** two consecutive local runs on fresh databases match on all 84 views.
  - **Baselines:** all are regenerated on the PR branch by the E2E workflow's
    `update_snapshots` and reviewed. `guest-complaint.png` is now `scan.png` (the
    explorer's name for `/s/:code`).
  - **Axe:** a critical finding on an F16 page (in the explorer's allow-list) is reported
    as known (`axe-known`), not failed.
- **`[QA-2]` Design ratchets** (`apps/api/scripts/design-ratchet.js`,
  `e2e/design-baseline.json`). Each count may only go down; a check fails only when it is
  worse, and `--update` lowers the baseline.
  - **Colour literals:** hex/rgb/hsl outside design-token definitions in `public/**/*.html`
    and `public/css/**`; 811 today. Checked by `ci-validate` (`npm run ci`).
  - **Colour contrast:** axe `color-contrast` nodes over every page view. Checked by
    `e2e.yml` after the suite.
  - **Summary:** `e2e-summary.json` gains `pages[].axeRules` / `known` / `diffImages` and
    `design.ratchets`. The Quality page's Design tab shows the ratchets and, for a page whose
    screenshot differs, where its actual and diff images are inside the `e2e-traces` artifact.
  - **Tests:** `test/design-ratchet.test.js` (passes at the baseline, fails at +1, lowers
    with `--update` and never raises; the token/selector exclusions; the contrast sum).
- **Docs:** `e2e/README.md` (design checks, ratchets), `docs/testing/TESTING.md`,
  `COVERAGE_MATRIX`. Charter §22: no API, architecture, data-model, deployment, environment or
  ADR change is triggered.

### 2026-10-17 (QA-2 production smoke, Quality tabs)

- **User-visible (Release Notes):** super-admins get four new tabs on the Quality page:
  Explorer, Design, Changes and Production.
- **`[QA-2]` Production smoke after every deploy and nightly**
  ([ADR 0009](docs/adr/0009-post-deploy-production-smoke.md)).
  - **Workflow:** a reusable `.github/workflows/prod-smoke.yml` (`workflow_call`, nightly
    22:00 UTC, `workflow_dispatch`). `deploy.yml` gains a job **Production smoke**
    (`needs: deploy`).
  - **Suite:** `e2e/prod-smoke.config.js` + `e2e/tests-prod/prod-smoke.spec.js`. It runs
    against `APP_URL` for the organization in the new repository variable
    `PROD_SMOKE_ORG_SLUG`.
  - **Checks:** `/health/ready`; the public and login pages (200, no console error, no
    failed same-origin request); static assets; security headers; http → https.
  - **Read-only, enforced:** a route guard aborts anything but GET/HEAD, direct checks can
    only send GET/HEAD, and service workers are blocked.
    `e2e/scripts/prod-smoke-summary.js` reports every method requested.
  - **Not run:** the in-app production checks. They need a super-admin sign-in and a POST,
    so the smoke does not run them, and no anonymous path was added.
  - **Results:** QA ingest source `prod-smoke`. On failure, a status-only alert through
    `ALERT_*` when those secrets are set.
- **`[QA-2]` Quality page: Explorer, Design, Changes, Production tabs.**
  - **Ingest:** `POST /api/qa/runs` accepts the sources `impact` (the change impact report)
    and `prod-smoke`, with array caps for their lists.
  - **Unchanged tabs:** without `?source=`, `GET /api/superadmin/qa/runs` and `/trend` now
    return the test suites only (`ci`, `e2e`, `local`), so the existing tabs and the trend
    are unchanged by the reports.
  - **Tabs:** they read the latest run of their source. Explorer and Design read the e2e
    run's `explorer` / `pages` / `design`. The tab list is now table-driven, and the arrow
    keys cycle through all six.
  - **Tests:** `qa-dashboard.test.js` (both sources accepted and filtered, an unknown source
    still 400, non-super-admin tokens still rejected for the new filters, the default list
    and trend hold test-suite runs only); e2e `quality-qa2-tabs.spec.js` (each tab with
    seeded runs, keyboard, axe).
  - **Visual:** the `superadmin-quality` baselines change deliberately (four more tab
    buttons) and are regenerated on this branch.
- **Docs:** ADR 0009, `docs/testing/TESTING.md` (the smoke and the tabs), `DEPLOYMENT.md`,
  `MONITORING.md`, `environment.md` and `.env.example`
  (`PROD_SMOKE_ORG_SLUG`, a CI-only variable), `e2e/README.md`, and the `QaRun.source`
  comment in the schema (comment only: no migration).

### 2026-10-17 (QA-2 change impact)

- **User-visible (Release Notes):** none; this is developer tooling. Every pull request now
  gets one comment listing what the change affects and what tests cover it.
- **`[QA-2]` Change impact report on every PR** (`apps/api/scripts/change-impact.js`,
  `.github/workflows/change-impact.yml`).
  - **What it maps:**
    - a page → that page;
    - `public/js` / `public/css` → the pages that load it (`app.js`: all);
    - a route file → its routes (checked against `routes.generated.md`) and the pages
      calling them;
    - shared server code → the routes of the route files that require it;
    - `prisma/` → the data model and each migration.
  - **Coverage:** for each item, the journeys, explorer and visual specs, API tests and bug
    scenarios that mention it. An item none mentions is flagged **changed but not covered**.
  - **Deterministic:** no AI, no network, Node built-ins only (no new dependency).
  - **Report-only:** the job is `continue-on-error` and the script always exits 0.
  - **Where it goes:** one PR comment marked `<!-- change-impact -->`, updated in place on
    each push (`GITHUB_TOKEN`, `pull-requests: write`). Also the QA ingest as source
    `impact`, best-effort: it answers 400 until the ingest accepts that source (QA-2 PR 4).
  - **Tests:** `test/change-impact.test.js`, 14 cases on a fixture repository (a page,
    `app.js`, a stylesheet, a route file, shared code, prisma, an uncovered page and route
    → "not covered", the comment, the ingest summary, the CLI never failing).
- **Docs:** new [`docs/testing/TESTING.md`](docs/testing/TESTING.md) (what runs when),
  indexed in `docs/README.md`. Charter §22: no API, architecture, data-model, deployment,
  environment or ADR change is triggered (a report-only CI job, no runtime change).

### 2026-10-17 (QA-2 explorer, BUG-0011)

- **User-visible (Release Notes):** on the supervisor Assets page, the Assets link in the
  navigation works again (it led to a "not found" page). On the Assets and Electrical pages
  every navigation link is right as soon as the page opens.
- **`[QA-2]` Explorer: an automated manual tester** (`e2e/tests/explorer.spec.js`, both
  projects).
  - **What it does:** for every role (guest, admin, supervisor, electrician, super-admin) it
    opens every page that role may open on a dedicated explorer org (assets module on).
    It waits for the auth/module sync, follows every in-app link one hop, and clicks
    `[role=tab]` controls. It never clicks a button.
  - **Checks:** document 200, no login bounce, sync done, nothing stuck loading, no
    same-origin request ≥ 400, no console error or uncaught exception, no "not found" text,
    no broken image, no link with the org slug twice, no horizontal overflow on the phone,
    axe critical = 0.
  - **Forbidden matrix:** each role opening the other roles' pages is sent to a login page
    (the super-admin to its dashboard), never shown the page.
  - **Page list:** taken from the route table. `apps/api/src/routes/pages.js` now exports
    `MODULE_PAGES` and a new `STATIC_PAGES` list. The static routes are registered from it;
    the route index is unchanged (211 API + 76 page routes).
  - **Allow-list:** `e2e/explorer-allowlist.json` holds pre-existing findings, shrink-only:
    F16 (critical axe `label`/`select-name` on 7 pages) and F17 (phone overflow on 3 admin
    pages). `scripts/summarize.js` reports entries that no longer reproduce ("remove me").
  - **Results:** `e2e-summary.json` gains `explorer` (role × page rows per viewport, the
    forbidden matrix, the allow-list state). The Quality page's tab for them comes later in
    QA-2.
  - **Red first:** on the pre-BUG-0010 `app.js` the explorer fails on the electrician and
    supervisor pages (the slug appears twice in a link, and following it answers 404). On
    this branch it passes 96/96.
  - **Support:** a run-cached `workerLogin()` / `signInElectrician()` (`e2e/support/app.js`);
    the explorer org and its fixtures in `global-setup.js`.
- **`[BUG-0011]` A role nav link hidden until the module sync came back double-prefixed.**
  - **What was broken:** BUG-0010's `data-page` was recorded only for links shown on the
    first pass. Also, `supervisor-assets.html` and `supervisor-electrical.html` rewrote every
    `#sv-nav` href themselves after `initSupervisor()`. On supervisor-assets, the Assets link
    became `/{org}/ele/{org}/ele/supervisor-assets` (404). Found by the explorer's first run.
  - **Fix:** `_applyRoleNavScope` records `data-page` before deciding visibility, and the two
    redundant inline rewrites are removed.
  - **Tests:** registry BUG-0011 (red first: the doubled Assets href, and the inline
    rewrites), the explorer's supervisor pages.
- **Docs:** `e2e/README.md`, `COVERAGE_MATRIX` (explorer row, role × page table, F16, F17),
  the generated bug registry. The Release Notes draft gains the nav fixes for electricians
  and supervisors (BUG-0010's line had been missed). Charter §22: no API, architecture,
  data-model, deployment, environment or ADR change is triggered (test tooling and a
  frontend fix; the route index regenerates unchanged).

### 2026-10-16 (BUG-0010)

- **User-visible (Release Notes):** the navigation links in the electrician and supervisor
  apps (Tickets, My Work, Scan, Attendance, …) work again. They had started leading to a
  "not found" page.
- **`[BUG-0010]` Role nav links were double-prefixed.**
  - **What was broken:** `_applyRoleNavScope` in `public/js/app.js` rewrote `#sv-nav` twice:
    at init (`initElectrician` / `initSupervisor`), and again after `/auth/worker-me`
    (`/auth/me`) returned (`_syncEnabledModulesFor*`). The second pass re-read the already
    rewritten `href`, so links became `/{org}/{mod}/{org}/{mod}/{page}` and answered 404.
    It was present since `530bbd5` (2026-07-24).
  - **Fix:** the first pass stores the original page in `data-page`, and every pass builds
    from it. The `data-mod` hide/show logic is unchanged.
  - **Tests:**
    - **e2e:** "electrician nav links work after module sync (BUG-0010)" and "supervisor nav
      links work after module sync (BUG-0010)" (`e2e/tests/journeys.spec.js`).
    - **Registry:** BUG-0010 (`scenarios/bugs/bug-0010-role-nav-double-prefix.js`) runs the
      real `app.js` in a Node `vm` with a stub DOM: init, then sync, then init again.
    - **Red first:** both e2e tests and BUG-0010 failed on the old code with the doubled
      `href`.
  - **Docs:** `e2e/README.md`, `COVERAGE_MATRIX` (journeys table), the generated bug
    registry. Charter §22: no API, architecture, data-model, deployment, environment or ADR
    change is triggered, because this is a frontend bug fix only.

### 2026-10-14 (runtime)

- **User-visible (Release Notes):** none intended. The same pages and API run on a newer,
  long-term-supported runtime. One fix ships with it: old bookmark links of the form
  `/{org}/{page}` redirect again (they would have failed on the new framework).
- **`[RUNTIME]` Node 24, Fastify 5, bcrypt 6** ([ADR 0008](docs/adr/0008-runtime-upgrade-node24-fastify5.md)).
  - **Runtime:** `node:24-alpine`, `engines >=24`, and CI, staging and e2e on Node 24. A
    report-only Node 22 job runs for one release.
  - **Packages:** fastify 4.29 → **5.12.5**; `@fastify/cookie` 11.1.2, `cors` 11.3.0,
    `helmet` 13.1.1, `multipart` 10.1.2, `rate-limit` 11.2.0, `static` 10.1.5; bcrypt
    5.1.1 → **6.0.0**. Each is the newest release at least 14 days old.
  - **Fastify 5 breaking changes:** all 22 are reviewed in ADR 0008. Code changes:
    - `reply.redirect(url, 301)` (`routes/pages.js:214`); the v4 argument order returned a
      500;
    - nothing else: empty-body DELETEs are already handled by the F14 parser, and
      `request.hostname` dropping the port only affects logs.
  - **New tests:**
    - `fastify5-compat` (12): the redirect (red on the old call), all 9 browser DELETE call
      sites with an empty JSON body, SSE over a real socket, and `hostname`/`host`;
    - `bcrypt-compat` (5): three bcrypt-5.1.1 hashes verify under bcrypt 6;
    - `bcrypt-compat-login`: a bcrypt-5 stored password signs in through the API.
  - **Audit:** runtime `npm audit` shows 0 vulnerabilities, and `.github/audit-exceptions.json`
    is empty (16 → 0).
  - **CI image smoke test:** build the production image, then run it against a fresh
    database (migrations applied in the image) and check `/health/ready` 200, bootstrap 200
    and an email-and-password login 200.
  - **Docs:** ADR 0008, the release-notes draft `docs/releases/v1.0.0-draft.md` (Charter §18;
    not tagged), DEPLOYMENT, the architecture overview, and the Charter §22 table.

### 2026-10-14 (visual baselines)

- **`[E2E]` All 20 visual baselines.** The two pages rejected in PR B now have deterministic
  inputs:
  - **admin-dashboard:** the browser clock is frozen to 2026-01-15, so its date picker no
    longer shows today.
  - **superadmin-quality:** the Live CI feed (`/api/superadmin/qa/ci-status`) is stubbed
    with three fixed runs, so the list has a fixed height and real content instead of a mask.
  - **Result:** their four Linux baselines (desktop and mobile) were generated in CI on this
    branch and reviewed. The 16 existing baselines are unchanged.

### 2026-10-14 (F13)

- **User-visible (Release Notes), admin:** permanently deleting a supervisor who still has
  history (tickets created, attendance marked, duty rosters, asset events or failures,
  inspections) now explains which records keep them, instead of failing with a server error.
- **`[F13]` Schema and migration drift resolved.** The decision: the database's current shape
  is the truth.
  - **`schema.prisma` now declares:**
    - `Ticket.createdBy` `onDelete: Restrict`;
    - `@@index([sourceIp, createdAt])`, `([slaDeadlineAt, status])` and
      `([orgId, status, verifiedAt])` on Ticket;
    - `@default(now())` on `updatedAt` for ModuleDefinition, OrgModuleActivation and
      SupervisorAssignment;
    - `@default([])` on `InspectionTemplate.locationTypes`.

    No database change for any of these.
  - **One migration**, `20261014000000_f13_module_defaults`: the `Organization.enabledModules`
    and `Ticket.module` defaults go from `'hk'` (a module that no longer exists) to `'ele'`.
    Defaults only; no rows are updated.
  - **Proof:** on a fresh database, `migrate deploy` then `migrate diff` in both directions
    leaves only the four Prisma 5 join-table primary-key/unique-index statements. Those are a
    known artifact, resolved at the Prisma 6 upgrade.
  - **Drift gate:** `ci-validate` now runs `scripts/schema-drift.js`. It diffs the migrated CI
    database against the schema and fails on any statement outside that four-statement
    allowlist (`test/schema-drift.test.js`). It is skipped locally without a database and
    required under `CI=true`.
  - **BUG-0009:** `DELETE /supervisors/:id/permanent` checked only inspections, so any of the
    other five RESTRICT references made it fail with a 500. It now pre-checks all six and
    answers 409 with the counts (`test/integration/supervisor-delete-guard.test.js`; red on
    the old code, 4 failures with 500).
  - **Docs:** `data-model.md`, `DEPLOYMENT.md` (the owner confirms `prisma migrate status` on
    the host before merging a migration), `COVERAGE_MATRIX` (F13 resolved).

### 2026-10-14

- **`[PR-B]` Caddyfile: `caddy fmt`, and the forwarded-header bug fixed.**
  - **Formatting:** `caddy fmt --overwrite` changed indentation only; the adapted JSON is
    byte-identical.
  - **Header lines:** removed the redundant `header_up X-Forwarded-For {remote}` and
    `X-Forwarded-Proto {scheme}`; kept `Host` and `X-Real-IP`.
  - **Proof** (throwaway `caddy:2-alpine` plus a fastify echo with `trustProxy: true`):
    - **Before:** `request.ip` was `172.23.0.1:42262`, because `{remote}` includes the
      client port.
    - **After:** `request.ip` is `172.23.0.1`.
    - **Unchanged:** `request.protocol` stays `https`, a client-supplied `X-Forwarded-For`
      is ignored both before and after, the token canary after a 502 stays 0, and
      `caddy validate` passes.
  - **Effects, a one-time change** (also in `docs/architecture/auth-and-tenancy.md`):
    - **Rate limits:** every per-IP rate limit (global, login, reset, public complaint,
      review, pages, QA ingest, super-admin checks and dispatch) was effectively per TCP
      connection and is now per client IP, as designed. That is stricter, and users behind
      one shared NAT address now share a bucket.
    - **Spam scoring:** the public-complaint IP hash (`public.js:282`) was taken over
      `ip:port`, so duplicate scoring rarely triggered. It works now; its window is 30
      minutes.
    - **Logs** show the bare IP.

- **`[PR-B]` Local pre-push gate and CLAUDE.md refresh.**
  - **Pre-push hook:** `.githooks/pre-push` now runs `npm run ci` in `apps/api`, the same
    gate as CI's Lint & Test (previously only lint and tests). It is still opt-in:
    `git config core.hooksPath .githooks`.
  - **`CLAUDE.md`** stays a map that links rather than duplicates. It now adds:
    - the root commands (`ci`, `doctor`, `seed`, `scenario`, `bug:*`, `release:check`,
      `e2e`, `e2e:ui`);
    - plan mode for non-trivial work, and test-first for bug fixes;
    - no Redis, queue or broker without an ADR (ADR 0002);
    - vanilla JS with no bundler;
    - modules as the extension mechanism;
    - the tenant contract: a server-derived `orgId`, and cross-org requests answer 404;
    - the bug-registry obligation;
    - the clean-copy test rule;
    - the finding-ID convention (`PRA-07/Cn`, `EP/Cn`, `Fn`, `BUG-nnnn`).

- **`[PR-B]` First Linux visual baselines.**
  - **Source:** 16 images from the authorized `update_snapshots` run on `main` (run
    38522159509), each reviewed by eye: right page, fixed test data only, dynamic regions
    masked. They are committed under `e2e/tests/__screenshots__/linux/`.
  - **Accepted (desktop and mobile):** admin-login, supervisor-login, electrician-login,
    admin-tickets, admin-locations, admin-qr-print, guest-complaint, electrician-my-work.
  - **Rejected, 4 images:**
    - **admin-dashboard** (×2): the date picker shows today's date. An `<input>` value is
      not a text node, so the date mask misses it.
    - **superadmin-quality** (×2): the masked Live CI list lists live GitHub runs, so its
      height, and with it the page size, changes from run to run.
  - **Until those masks are fixed in `e2e/support/visual.js`**, the four rejected views
    keep reporting "no baseline" and don't fail.

- **`[PR-B]` The local dev database moved to `127.0.0.1:5433`** (`docker-compose.dev.yml`), so it
  never shares a host port with the production compose (`127.0.0.1:5432`).
  - **Updated:** `.env.dev.example` (`DATABASE_URL`), `apps/api/README.md` and
    `apps/api/test/README.md`. `npm run doctor` now warns when a local `DATABASE_URL`
    still uses 5432.
  - **Existing dev setups:** update `DATABASE_URL` in your `.env` to port 5433, then run
    `docker compose -f docker-compose.dev.yml up -d` to rebind. The data volume is
    unchanged.

- **`[PR-B]` Backups run inside the app image.**
  - **What was broken:** `infrastructure/backup-db.sh` and `restore-db.sh` called host
    `node`, which the production host doesn't have, so the offsite upload, prune and
    download could not run. The scripts were also committed without the executable bit,
    which they need for the cron line.
  - **Now:** both run `apps/api/scripts/backup-r2.js` through
    `docker compose exec -T api node scripts/backup-r2.js ...`, streaming the archive
    through stdin (`upload - <name>`) and stdout (`download … -`, `download-latest -`).
    There is no compose change, and the container never reads the host backup directory.
  - **`backup-r2.js`:** loads dotenv quietly, because dotenv 17's stdout banner would
    otherwise corrupt the archive stream. It also validates the stdin archive name and
    rejects empty input.
  - **On failure:** pruning (local and offsite) still runs. The job logs
    `offsite upload failed`, keeps the local archive, and exits non-zero. A dump failure
    exits non-zero before any upload.
  - **Tests:** `infrastructure/tests/backup-db.test.sh` (18 checks: success, upload
    failure, dump failure) and `backup-r2-stdio.test.sh` (9 checks, stubbed S3), both run
    in the deploy workflow's test job.
  - **Docs:** DISASTER_RECOVERY and RUNBOOKS, including the one-time owner verification.

- **`[PR-B]` Every deploy checks the running Caddy.**
  - **The checks:** after the API is healthy, both deploy scripts run `caddy validate` on the
    running container's config and require `caddy adapt … | grep -c REDACTED` to be at
    least 1, which shows the C11 credential log filter is live. Either failure fails the
    deploy. Caddy's logs and config are never printed.
  - **Recorded commit:** the deployed commit is written to `~/.electrical-deployed-sha` (or
    `~/.electrical-staging-deployed-sha`) outside the repo, and the next deploy uses it to
    note whether the Caddyfile changed.
  - **Correction:** the 2026-10-13 report said the filter was not live because deploys never
    recreate Caddy. That was wrong. Both deploys run `docker compose down` before
    `up -d`, which recreates Caddy every time. The filter has most likely been live since
    PR #3 deployed, and these checks now prove it on every deploy.

- **`[PR-A]` GitHub Actions bumped to their current majors** in `deploy.yml`,
  `deploy-staging.yml` and `e2e.yml`: `actions/checkout` v4 → v7, `actions/setup-node`
  v4 → v7, `actions/upload-artifact` v4 → v7.
  - **What changed, from the release notes:**
    - all three run on Node 24 (runner ≥ 2.327.1);
    - checkout v6 keeps the persisted credentials in a separate file, and v7 refuses to check
      out fork code for `pull_request_target`/`workflow_run` (not used here);
    - setup-node v5 auto-caches when `package.json` has `packageManager` (ours has none,
      and `cache: npm` stays explicit), v6 limits that to npm, and v7 adds cache outputs and
      drops the dummy `NODE_AUTH_TOKEN`;
    - upload-artifact v7 adds an `archive` input (default `true`).
  - **No input changes are needed** in our workflows. `appleboy/ssh-action` is unchanged.

- **`[PR-A]` Dependency audit gate (closes PRA-07/C1; [ADR 0007](docs/adr/0007-dependency-audit-gate.md)).**
  - **The step:** a new "Dependency audit gate" step in the deploy workflow's Lint & Test
    job runs `apps/api/scripts/audit-gate.js` after CI validation.
  - **What it checks:** it fails on any high or critical `npm audit --omit=dev` advisory
    not listed in `.github/audit-exceptions.json`, and on any exception past its
    `expires` date. A registry or network error only warns.
  - **The 16 current exceptions:**
    - the Fastify 4 chain (`fastify` ×5, `find-my-way`, `@fastify/static`), expiring
      2026-12-13: they need Fastify 5, and runtime reachability is assessed per advisory;
    - `tar` ×9, expiring 2026-11-13: install-time only, via bcrypt 5's `node-pre-gyp`,
      and fixed by moving to bcrypt 6.
  - **Tests:** `test/audit-gate.test.js` (14) with fixtures for a clean report, an
    unlisted high, a listed advisory, an expired exception, a registry error, and the
    committed file's expiry windows.

- **`[PR-A]` Runtime dependency security fixes.**
  - **What changed:**
    - `npm audit fix` (never `--force`) took `proxy-addr` to 2.0.8, `fast-uri` to 2.4.7/3.1.8, `@fastify/busboy` to 3.2.3, and also patched `fast-xml-parser` (via the AWS SDK) and `minimatch`/`brace-expansion`.
    - `nodemailer` went from 6.x to **10.0.11** and `sharp` from 0.33 to **0.35.5**. Both are the oldest releases that fix every advisory and have been published for at least two weeks. Both need Node ≥ 20(.9); production runs `node:20-alpine`.
    - `email.js` and `r2.js` needed no change: nodemailer's breaking changes (SES SDK transport, remote-content TLS, TypeScript build) and sharp's (Node 18 dropped, AVIF tuning, removed deprecated options) don't touch SMTP sending or `resize` → `webp`.
    - `fastify`, the `@fastify/*` direct versions, prisma and Node are unchanged.
  - **Result:** runtime advisories went from 14 (3 critical, 10 high, 1 moderate) to 5 (1 critical, 4 high). What remains is the Fastify 4 chain (`fastify`, `find-my-way`, `@fastify/static`), which needs Fastify 5, and `tar` via bcrypt 5's install-time `node-pre-gyp`, which is not loaded at runtime. These are listed with expiry dates in `.github/audit-exceptions.json`.
  - **Tests:**
    - `test/lib-email.test.js` covers sending through nodemailer's real `jsonTransport`, the failure path, `verify()` and not-configured.
    - `test/lib-storage.test.js` checks that 1600×1200 becomes an 800×600 WebP, that small images are never enlarged, and the `validateImageBuffer` magic-byte cases.
    - `test/integration/upload-validation.test.js` checks, on the public complaint route, that a wrong type gets 400, mismatched magic bytes get 400, and a file over 5 MB gets 413.
    - Also checked in a throwaway `node:20-alpine` container: `npm ci --omit=dev`, and sharp 0.35.5 producing an 800×600 WebP.

### 2026-10-13

- **User-visible (Release Notes):** Electricians can now see complaint and proof photos;
  fixed a fault where loading photos could make the whole platform briefly unavailable.
- **`[F15]` Database circuit breaker counts only infrastructure failures (BUG-0008).**
  - **What was broken:** `dbBreaker` counted every error from a Prisma operation as a
    database failure. The electrician queue loads ticket photos through `/api/images` with
    the worker token, and that route looked the token up as a staff user
    (`id: undefined`), which threw a Prisma validation error. Five of those within 60 s
    opened the breaker, and every request from every user got `503` for 30 s.
    Electricians never saw the photos either (401).
  - **Breaker fix (`src/lib/circuit-breaker.js`, one place):** only infrastructure failures
    count. Those are initialization errors, engine panics, `P1001`/`P1002`/`P1008`/`P1017`/
    `P2024`, and `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`. Validation errors and every other
    `P2xxx` still reach the caller but no longer count, and neither does
    `PrismaClientUnknownRequestError` (see `docs/architecture/resilience.md`).
  - **Probe change:** recovery after a counted failure is unchanged. If the trial request
    fails with an error that does not count, the next request becomes the trial instead.
  - **`middleware/auth.js`:** a token without `userId` now gets `401` before any query.
  - **`/api/images`:** accepts staff and worker tokens, with the same checks as the
    header-based auth paths: active account, `tokenInvalidBefore`, and active org. Another
    org's image now answers `404` instead of `403`.
  - **Tests:** `test/db-breaker-classification.test.js` and
    `test/integration/f15-images-and-auth.test.js`. They failed on the old code (16 of 32)
    and pass now.

- **User-visible (Release Notes):** Password and PIN reset links from email now open a
  working reset page.
- **`[F12]` Reset pages (BUG-0007).** The reset emails link to `/reset-password?token=…` and
  `/worker-reset-pin?token=…`, but neither page existed. Both URLs fell through to the
  `/:orgSlug` route and answered "Organization not found".
  - **Fix:** new `public/reset-password.html` and `public/worker-reset-pin.html`, with their
    scripts in `public/js/`, routes in `src/routes/pages.js`, and both names added to
    `NON_ORG_PREFIXES`. These are top-level paths, not `/{orgSlug}/{module}/{page}` (Charter
    §10). That is deliberate: links already sent in emails fix the URLs, and the pages serve
    users who have no org context yet, like `/superadmin-login`.
  - **Token handling:** each page reads `?token=` once, then removes it from the address bar
    with `history.replaceState`. `<meta name="referrer" content="no-referrer">` keeps it out
    of `Referer` headers.
  - **What the pages do:** they POST to the existing `/api/auth/reset-password` and
    `/api/auth/worker-reset-pin`. On success they link to the right login page. An expired
    or already-used link gets a clear message.
- **PIN modal says 6 digits.** `admin-workers.html` used to ask for "4-6 digits" while the
  API requires exactly 6. The label, `pattern`, `minlength`/`maxlength` and the client-side
  check now all say 6.
- **Super-admin audit URL without its query.** The `sa_org_context_*` audit row
  (`middleware/auth.js`) now stores `stripQuery(request.url)`, so a `?token=` never lands in
  `AuditLog.newValue`.
- **Tests:** `test/integration/reset-pages.test.js` covers both pages, the logs, the audit
  row and the PIN markup. It failed on the old code (5 failures) and passes now.
- **`[C11]` Tokens out of Caddy's log and the public deploy log.**
  - **Deploy log:** `deploy.yml` no longer prints `docker compose logs caddy` (only
    `docker compose ps caddy`). The API log dump on a failed health check stays.
    `deploy-staging.yml` never printed Caddy's logs.
  - **Caddy log filter:** `infrastructure/Caddyfile` gains a global log filter. Caddy's error
    log (e.g. a 502 during an API restart) recorded the full request URI, `?token=`
    included. Every query value and the `/review/` token are now logged as `REDACTED`, and
    proxying is unchanged.
  - **Verification:** a throwaway `caddy:2-alpine` canary test: count 4 → 0, upstream still
    200, and `caddy validate` passes on the full file.

- **User-visible (Release Notes):** Electricians can pick up tickets again; acknowledging
  alerts, generating AI insights, duplicating templates and running production checks work
  again.
- **`[F14]` Body-less JSON requests accepted (BUG-0006).** `public/js/app.js` always sends
  `Content-Type: application/json`, and Fastify rejected an empty JSON body with
  `400 FST_ERR_CTP_EMPTY_JSON_BODY` before auth. That broke every body-less POST/PATCH from
  the browser: electrician Pick Up, alert acknowledge (and acknowledge-all), AI insight
  generate, template duplicate, notification mark-read and read-all, supervisor accept and
  pickup, and the production-checks button.
  - **Fix (server-side, one place):** `src/plugins/content.js` replaces the JSON parser. An
    empty or whitespace-only body is read as `{}`; everything else goes to Fastify's own
    parser, with prototype- and constructor-poisoning protection set to `error` and the body
    limits unchanged. This also covers browsers holding a cached `app.js`.
  - **Tests:** `test/integration/empty-json-body.test.js` replays all 12 call sites
    browser-style. It failed on the old code (24/24 rejected) and passes now. It also checks
    that malformed JSON and poisoning payloads are still rejected.

- **User-visible (Release Notes), super-admin:** the Quality page has an **End-to-end** tab.
  It shows the latest browser test run (journeys, accessibility and visual checks, with links
  to the run and its report) and a **Run full test suite now** button.
- **`[E2E-4]` e2e CI, reporting and the run-suite button.**
  - **`.github/workflows/e2e.yml`:** triggers on PRs (no branch filter; `apps/api/**`,
    `e2e/**`), nightly at 21:30 UTC, and `workflow_dispatch` (`update_snapshots`,
    `requested_by`).
    - It runs against a Postgres service on Node 22.
    - The report is uploaded every run and traces only on failure, both kept 7 days.
    - The Linux baselines are uploaded when `update_snapshots` is set.
    - The summary (`e2e/scripts/summarize.js`) is posted to the Quality ingest with
      `source: 'e2e'`.
    - The deploy workflow is untouched.
  - **`POST /api/superadmin/qa/dispatch`:** SUPER_ADMIN only, one call per 10 minutes, and
    404 while `GH_ACTIONS_DISPATCH_TOKEN` is unset.
    - It starts `e2e.yml` on `main` with `requested_by=superadmin`.
    - GitHub 200 → the page shows the run link. 204 → "started". 404/422 → "the e2e workflow
      is not on main yet: it only becomes dispatchable after batch-2 is merged". 401/403 →
      "dispatch token invalid, expired, or missing Actions write". 429 or a timeout →
      "GitHub unavailable, try later".
    - Every call is audited as `sa_test_suite_dispatched` (statuses only). The token is
      never returned or logged.
  - **`ci-status`** now reports `dispatchEnabled`.
  - **Tests:** `test/integration/qa-dispatch.test.js` (14 tests) and the e2e test
    `quality-e2e-tab.spec.js`.
- **User-visible (Release Notes):** screen readers now announce the mobile menu button on
  admin pages ("Menu").
- **`[E2E-3]` Design and accessibility checks (`e2e/tests/visual-a11y.spec.js`).** Ten pages
  are checked on desktop and on a Pixel 7.
  - **Visual:** `toHaveScreenshot` with the dynamic regions masked. Baselines are Linux
    only, generated in CI. Until one exists, the check records "no baseline" and does not
    fail.
  - **Accessibility:** axe (WCAG 2.0/2.1 A + AA), report-only, failing only on critical
    violations. Its first run found one critical, `button-name`: the mobile menu button
    `#nav-toggle` had no accessible name on 11 admin pages. It now has `aria-label="Menu"`,
    the same as `admin-attendance.html` already did.
  - **Baseline counts:** 0 critical. The 45 serious nodes are `color-contrast`,
    `link-in-text-block` and `scrollable-region-focusable`; see `e2e/README.md`.
- **`[E2E-2]` Browser journeys J1–J8 (`e2e/tests/`).**
  - **J1–J6, one story:** an admin creates a location and prints its QR; the QR decodes to
    `APP_URL/s/<code>`. A guest on a phone reports a fault with a photo, and the database
    shows the F2 nearest-supervisor assignment and F3's single notification. An admin adds
    an electrician with PIN 123456, who signs in on a phone, sees the photo (F15) and picks
    the ticket up (F14). The electrician resolves it with a proof photo; the supervisor
    verifies and closes it, and the guest review link loads. Finally an internal ticket
    shows in both lists.
  - **J7 (negative cases):** an electrician can't open admin pages or APIs; org B can't
    see org A's ticket; a wrong PIN shows an error; an invalid complaint creates nothing.
  - **J8 (phone only):** the worker PIN reset from the emailed link (F12). The token is
    removed from the address bar, the new PIN works, and the link can't be used twice.
  - **Run with the fixes:** this found F14 and F15. With both fixed, three consecutive full
    runs are green (15/15 each).
- **`[E2E-1]` Browser end-to-end package (`e2e/`).** It is a separate package with its own
  lockfile and Node ≥ 22; the app stays on Node 20 and its dependencies and lockfile are
  unchanged (ADR 0006).
  - **Dependencies:** `@playwright/test` 1.63.0 (Apache-2.0), `@axe-core/playwright` 4.13.0
    (MPL-2.0), `jsqr` 1.4.0 (Apache-2.0), and `playwright-core` 1.63.0, pinned to dedupe.
  - **Configuration:** projects `chromium-desktop` and `chromium-mobile` (Pixel 7), with
    HTML/JUnit/JSON reports in `e2e/reports/`.
  - **App under test:** `webServer` starts the real app on :3100 with local storage, blanked
    outbound credentials and generated secrets.
  - **Safety:** the suite refuses any database that isn't loopback `_e2e`, reusing
    `apps/api/test/setup/safety-rules.js`.
  - **Seed:** a per-run seed through the scenario factories, with generated credentials only.
  - **Root scripts:** `npm run e2e` (a disposable `postgres:15-alpine` container
    `e2e-pg-<pid>` on 127.0.0.1:55433, removed at the end), `e2e:ui` and `e2e:codegen`.
    Includes an environment smoke spec.

- **User-visible (Release Notes):**
  - **Every electrician now needs an Employee ID.** It is required when adding an
    electrician (admin and super-admin screens), and it can't be blanked out later,
    because it's what electricians sign in with alongside their PIN. Electricians added
    earlier without one are unchanged, but an Employee ID must be entered the next time
    one of them is edited.
  - **Supervisors get one notification per public complaint.** A supervisor responsible
    for the location no longer receives two.
  - **Tickets go to the nearest responsible supervisor.** When several supervisors cover
    a location, a new complaint or ticket is now consistently assigned to the one closest
    to it.
- **User-visible (Release Notes), super-admin:** a new **Quality** page (`/superadmin-quality`,
  linked from the super-admin dashboard). It shows:
  - the latest automated test run (warning whenever tests didn't run), a 30-run trend and
    run history with per-file and per-failure detail
  - live CI status
  - a **Run production checks** button that checks the database, offsite backups, email,
    configuration and build without changing anything
- **`[WP-Q]` Super-admin Quality page.**
  - **New model:** `QaRun` (additive migration `20261013000000_wp_q_qa_runs`). It is
    platform-level, not tenant-scoped, and keeps the newest 500 rows.
  - **New routes:** `POST /api/qa/runs` (ingest), authenticated by `QA_INGEST_TOKEN`; it
    returns 404 when unset, compares in constant time, and enforces a 256 KB limit, zod
    validation and a rate limit. Also SUPER_ADMIN-only `GET /api/superadmin/qa/runs`,
    `/runs/:id`, `/trend` and `/ci-status`, and `POST /api/superadmin/qa/checks`, which is
    read-only, streamed as NDJSON, limited to one per 30 s and audited.
  - **New libraries:** `lib/github.js` (versioned headers, 10 s timeout, 60 s CI-status cache,
    whitelisted fields, token-expiry check) and `services/production-checks.js`.
  - **Small additive exports:** `email.js` `verifyTransport()` (never sends) and `r2.js`
    `getR2Client`.
  - **Report:** `scripts/report-tests.js` also writes `reports/test-summary.json` (scrubbed,
    ≤ 200 KB).
  - **Page:** `public/superadmin-quality.html` + `js/superadmin-quality.js` (no inline script).
  - **Tests:** `production-checks.test.js` and `integration/qa-dashboard.test.js`.
  - **Docs:** ADR 0005, MONITORING, auth-and-tenancy (`QaRun` is not tenant-scoped),
    environment (`QA_GITHUB_REPO`), the route index and COVERAGE_MATRIX.
- **`[WP-OPS]` Deploy and CI hygiene.**
  - **`docker-compose.yml`:** the db healthcheck uses `$$POSTGRES_USER`/`$$POSTGRES_DB`
    (expanded in the container, not interpolated empty from the host). The `api` service
    receives `GIT_SHA`, `IP_HASH_PEPPER`, `QA_INGEST_TOKEN` and `GH_ACTIONS_DISPATCH_TOKEN`.
  - **`deploy.yml`:**
    - `pull_request` has no branch filter, so stacked PRs run the test gate; the deploy
      job's `push && main` guard is unchanged.
    - The deploy job passes those four values (`GIT_SHA` from `github.sha`) to the server.
    - The test job posts the scrubbed test summary to the Quality dashboard ingest:
      best-effort, it skips when the secrets are empty and prints only the HTTP status.
  - **`deploy-staging.yml`:** mirrors this, with `STAGING_`-prefixed server secrets. It also
    switches to `npm run ci` and fixes a 30-char JWT placeholder that failed app boot.
  - **Docs:** `.env.example`, `reference/environment.md` (closes finding M2) and
    `DEPLOYMENT.md`.
- **`[WP-H]` Approved fixes F2, F3, F4 and F8.**
  - **F2:** stable assignment order in `services/assignment-resolver.js` (direct, then
    nearest ancestor, then `isPrimary` for workers, then `createdAt`, then `id`).
  - **F3:** `notifySupervisors()` gains an optional `{ excludeUserIds }` argument,
    backward compatible; the public-complaint broadcast skips the supervisors who were
    already notified directly.
  - **F4:** failed notification steps on ticket creation (`public.js`, `tickets.js`) log
    one `warn` line `{ ticketId, step, err }`; they stay fire-and-forget.
  - **F8:** `employeeId` is required on worker create and can't be cleared via PATCH, on
    both the admin and super-admin routes. This is an API contract change (Charter §9):
    those requests now return 400.
  - **Tests and docs:** `test/integration/approved-fixes.test.js`,
    `test/integration/notification-step-warn.test.js`; bug registry BUG-0004 (F3) and
    BUG-0005 (F8); `COVERAGE_MATRIX.md` updated.
- **`[WP-A]` Credentials kept out of logs and alerts.** The app carries credentials in URLs
  (`?token=` on the SSE streams and `/images/`, `/review/:token`, reset links). Logs and
  alerts now describe a request by its route template, falling back to the path without its
  query; they never use the raw URL.
  - New `apps/api/src/lib/log-redaction.js`: `stripQuery`, `describeTarget`,
    `scrubJwtShapes`, `buildLoggerOptions`.
  - Every logger `buildApp()` creates gets `req`/`url`/`err` serializers and a `logMethod`
    hook (no pino `redact`), merged into a caller-supplied logger too.
  - The slow-request log, Telegram/webhook alerts and `error.log` are scrubbed.
  - Regression tests use a canary JWT across every token URL shape, the slow path, the 5xx
    path and a caller-supplied logger, plus a control run showing that an unpatched logger
    leaks.
  - Also: `scripts/run-tests.js` now prints "test report could not be produced" once,
    instead of twice.

### 2026-10-12

- **`[QA-1]` Test-target safety, skip gate, run report, coverage inventory** —
  - **Safety guard.** `npm test` (and `bug:test`, `test:phase1`) now runs through
    `apps/api/scripts/run-tests.js`, which loads `test/setup/safety.js` into every test
    process. The guard **fails closed**: tests refuse to start unless `NODE_ENV=test` and
    `DATABASE_URL` points at a loopback host and a database named `*_ci`/`*_test`/`*_e2e`
    with no connection-redirecting query parameters. Under `CI=true` the URL must also be
    explicit in the environment. It blanks outbound SES/alert/AI credentials and
    placeholders R2 before dotenv can inject the real `.env` values.
  - **Skip gate.** `test/helpers/db.js#isDatabaseAvailable()` re-checks the same rules
    against the URL Prisma actually captured. Under `CI=true` an unreachable database now
    **fails** DB-backed tests instead of silently skipping them, and the run fails on any
    skipped/todo/cancelled test (also opt-in locally with `QA_STRICT=1`).
  - **Run report.** Each run writes a scrubbed `reports/junit.xml` and a readable
    `reports/test-summary.md`: counts, baseline vs current, per-tier and per-file tables,
    failures with an ENVIRONMENT/UNCLASSIFIED classification, and a
    `NOT EXECUTED: N — this is not a pass` line. These use Node's built-in spec/JUnit
    reporters plus a small reporter on Node's own API (`scripts/report-events.js`) for the
    file paths and hook errors that Node 20's JUnit output drops.
  - **Inventory.** New `docs/testing/COVERAGE_MATRIX.md`, with characterisation findings
    F1–F11 (open questions for the owner, no code changed).
  - **Docs and tests.** `apps/api/test/README.md` and `apps/api/README.md` are corrected,
    including the stale demo electrician PIN (`123456`, not `1234`). New tests: safety
    guard, DB gate, report, preload canary.
  - **Scope.** Verified on Node 24.11.1 and Node 20.20.2 against a disposable Postgres. No
    production code, dependency, workflow or compose change.

### 2026-07-22

- **Production observability & operational diagnostics (platform milestone M6)** — Added a
  `GET /health/info` operational-diagnostics endpoint (version/build/runtime metadata,
  dependency health, and secret-free configuration booleans), a universal `x-request-id`
  response header for request correlation (reusing the existing request id and pino
  request-scoped logger — error responses already carried `requestId`), slow-request
  logging at `warn` (default 2000ms, `SLOW_REQUEST_MS`; SSE streams excluded), and a
  one-line startup runtime-configuration summary. All observability draws from one source of
  truth (`apps/api/src/lib/diagnostics.js`), shared by the endpoint and the startup log; the
  hooks live in `apps/api/src/plugins/observability.js`. No business functionality changed;
  no second logging or monitoring system introduced. Existing health endpoints unchanged.
- **CI/CD validation platform (platform milestone M5)** — Added one comprehensive CI gate,
  `npm run ci` (lint + the full test suite — which already includes the scenario platform
  and bug regression library — plus new repository-structure, package-integrity,
  environment-documentation, migration-safety, and generated-doc-drift checks in
  `apps/api/scripts/ci-validate.js`), and `npm run release:check` for deployment readiness.
  The production CI workflow's **test gate** now runs `npm run ci` (the deploy job's SSH/
  docker logic is unchanged), so CI and local validation can never diverge, and deployment
  stays an intentional, gated action. **Fixed a latent CI defect**: the workflow's
  placeholder `JWT_SECRET` was 30 chars, below the app's own 32-char boot minimum, so the
  gate would have failed at app startup. **Fixed a cross-platform defect**: `npx`/`npm`
  spawned from the M2/M3 platform scripts (`doctor`/`setup`/`reset`) failed on Windows
  (`ENOENT`/`EINVAL`); they now spawn with `shell: true` via a shared `_platform` helper.
- **Bug reproduction platform & regression library (platform milestone M4)** — Built a
  production-incident framework on top of the M3 scenario system (`apps/api/scenarios/bugs/`):
  every fixed defect is a reproducible scenario with full metadata (id, severity, status,
  module, root cause, dates, scenario dependencies, regression mapping) and a `validate()`
  that asserts the fixed behavior via the real app. Seeded with three real fixed defects
  (BUG-0001 ticket-state guard, BUG-0002 worker-delete parity, BUG-0003 public-complaint
  spam enforcement). Added commands `npm run bug:list` / `bug:run` / `bug:validate` /
  `bug:test` (reusing the M3 engine and the production-safety guard — no duplicated
  execution logic), a generated catalog (`docs/reference/bug-registry.generated.md` via
  `npm run docs:bugs`), and a driving regression test (`test/integration/bug-regressions.test.js`)
  so any reverted fix fails the suite. No production runtime changed.
- **Scenario system, demo dataset & seed platform (platform milestone M3)** — Introduced a
  reusable business-scenario system (`apps/api/scenarios/`) that is the single source of
  truth for local development, the demo dataset, tests, and (later) bug reproduction. The
  test factories were extracted verbatim to `apps/api/scenarios/factories.js` and
  re-exported by `test/helpers/db.js`, so tests and seeding share one factory system (no
  duplication). Added an 11-scenario catalog (fresh-installation, demo-organization, and
  the ticket/electrical/attendance/notification/AI/supervisor/worker/admin/reporting
  workflows), a dependency-resolving engine, and the commands `npm run seed` / `demo` /
  `scenario` (all local-only, production-guarded) plus completed `npm run reset` (db reset
  + seed). Demo data is deterministic (verified: two seeds produce an identical
  fingerprint). New regression tests: `test/integration/scenarios.test.js`.
- **Developer command interface & environment (platform milestone M2)** — Added a
  root-level developer command surface (`npm run setup` / `dev` / `doctor` / `verify` /
  `reset` / `clean`) per the Developer Platform Specification §2, plus `docker-compose.dev.yml`
  (Postgres-only, isolated volume) for a fast host-run inner loop. `reset`/`clean` carry a
  production-safety guard (`apps/api/scripts/_platform.js`) that refuses to run against any
  non-local database. `verify` composes lint + tests + a route-index drift check. Fixed a
  pre-existing test-fallback bug (`app-smoke.test.js`'s 30-char `JWT_SECRET` fallback
  predated WP13's 32-char minimum, breaking `npm test` from a fresh shell). Documentation
  only affects developer workflow; no production runtime behavior changed.
- **Local storage driver (platform milestone M1)** — Added a `STORAGE_DRIVER` (`r2` default
  | `local`) abstraction to `apps/api/src/lib/r2.js`. `local` stores uploaded images on the
  filesystem (`data/uploads/`, git-ignored) and serves them through the existing `/images/`
  proxy, so the app boots and handles image uploads with **no cloud credentials** —
  `config/env.js` drops the R2 vars from the required set when `STORAGE_DRIVER=local`. Added
  `.env.dev.example` (copy-once local config) and a README local-run guide. Production is
  unchanged: with `STORAGE_DRIVER` unset/`r2`, behavior is byte-for-byte identical.
  Regression tests: `test/lib-storage.test.js` (local driver upload/serve/delete/404/traversal)
  and two new cases in `test/config-env-validation.test.js`.

### 2026-07-21

- **Engineering knowledge base** — Built out the documentation system beyond `[WP16]`'s
  foundation into a complete, navigable knowledge base: a documentation index
  (`docs/README.md`), an AI-assistant entry point (`CLAUDE.md`), a frozen
  production-readiness snapshot (`docs/history/`), the architecture explanation set
  (`docs/architecture/` — overview, auth & tenancy, data model, module system, resilience,
  frontend), generated/semantic reference docs (`docs/reference/routes.generated.md` via
  `apps/api/scripts/gen-route-index.js` / `npm run docs:routes`, and
  `docs/reference/environment.md`), operations docs (`docs/MONITORING.md`,
  `docs/RUNBOOKS.md`), and an ADR framework (`docs/adr/` index + template + foundational
  ADRs 0002–0004). Integrated the doc system into the Charter's §22 trigger table and
  removed the empty `docs/replication-pack/` placeholder. Documentation-only; no
  application behavior changed.
- **`[WP16]` Documentation & Release Process Hygiene** — Established this CHANGELOG and
  the root `README.md`. Corrected a garbled comment in `apps/api/index.js` describing the
  image-cleanup scheduler's timer-capture fix.
- **`[WP15]` Notification Channel Unification** — Notification+email pairs that previously
  fired as two independent calls (`tickets.js`, `public.js`) now go through one shared
  `notify()` interface (`services/notification-service.js`), so a future channel addition
  (SMS, push) is one change, not one change per call site.
- **`[WP10]` Automation & Alerting Reliability** — Consolidated three duplicated
  AI-provider-calling implementations into one shared module (`lib/ai-provider.js`),
  closing a gap where scheduled AI insight generation ran with no circuit-breaker
  protection. Missed-inspection alerting now reads each org's configured shift windows
  instead of a hardcoded deadline table.
- **`[WP11]` Public Complaint Abuse Prevention** — The spam risk score computed on public
  complaints is now enforced (`429` at its existing top tier) instead of only recorded.
  The abuse-detection IP hash is now peppered (`IP_HASH_PEPPER`), with a safe unpeppered
  fallback when unset.
- **`[WP14]` Account Recovery & Authentication Session UX** — Added self-service password
  reset (`User`) and PIN reset (`Worker`), with single-use, time-limited,
  anti-enumeration-protected tokens. Worker PIN changes no longer force an unnecessary
  re-login.

### 2026-07-20

- **`[WP13]`** Production-readiness pass — `JWT_SECRET`/`COOKIE_SECRET`/`ADMIN_KEY` are now
  validated for minimum strength at boot, not just presence. A startup warning now catches
  a typo'd `NODE_ENV`.
- **`[WP12]` Operational Resilience, Error Handling & Recovery** — The database and
  AI-provider circuit breakers (`dbBreaker`, `aiBreaker`) are now actually wired into all
  real traffic (a Prisma Client Extension covers every database call; both live AI
  endpoints are wrapped) instead of only being displayed on `/health`. Added an
  `uncaughtException` process handler alongside the existing `unhandledRejection` one.

### 2026-07-19

- **`[WP11]`** (performance) — Location-hierarchy walks (`services/assignment-resolver.js`)
  rewritten as single-round-trip recursive CTEs instead of one query per hierarchy level.
  One alert-notification path batched into a single `createMany` instead of one insert per
  recipient.
- **`[WP10]`** (state-transition consistency — see `docs/ENGINEERING_CHARTER.md` §8.2;
  distinct from the same-numbered `[WP10] Automation & Alerting Reliability` above) —
  Generic admin PATCH routes (`tickets.js`, `assets.js`) could previously set fields into
  states their own dedicated action routes would never produce; both gaps closed.
- **`[WP9]`** — Multi-step writes across the asset/failure/event workflows are now wrapped
  in `$transaction`; eliminated a create-then-update double-write in ticket
  auto-assignment.
- **`[WP8]`** — SuperAdmin `X-Org-Id` cross-tenant reads are now fully audited (previously
  only non-`GET` requests were logged). Fixed two routes mislabeling a SuperAdmin's write
  as a supervisor's in the org's own audit trail.
- **`[WP7]`** — Closed Audit finding `[H1]`: an exhaustive, file-by-file tenant-scoping
  sweep of every route, plus new regression tests
  (`test/integration/tenant-isolation*.test.js`). No exploitable cross-tenant leak was
  found; several defense-in-depth gaps were hardened anyway.
