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
  - **Summary:** `e2e-summary.json` gains `pages[].axeRules` / `known` and
    `design.ratchets` (shown on the Quality page's Design tab).
  - **Tests:** `test/design-ratchet.test.js` (passes at the baseline, fails at +1, lowers
    with `--update` and never raises; the token/selector exclusions; the contrast sum).
- **Docs:** `e2e/README.md` (design checks, ratchets), `COVERAGE_MATRIX`. Charter §22: no
  API, architecture, data-model, deployment, environment or ADR change is triggered.

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
