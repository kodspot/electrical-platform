# End-to-end, visual and accessibility tests (`e2e/`)

This suite drives the real app in a real browser (Playwright, Chromium) at desktop and phone
sizes. It is a separate package from the app on purpose: its own dependencies and lockfile,
and Node ≥ 22, while the app stays on Node 20. See
[ADR 0006](../docs/adr/0006-browser-e2e-with-playwright.md).

## Run it

From the repository root, with Docker running:

```
npm --prefix e2e ci                 # once (and after e2e/package-lock.json changes)
npx --prefix e2e playwright install chromium
npm run e2e                         # headless: both projects (desktop + mobile)
npm run e2e -- --grep J2            # any Playwright arguments pass through
npm run e2e:ui                      # Playwright UI mode, same disposable database
```

`npm run e2e`:
- starts a **disposable** `postgres:15-alpine` container named `e2e-pg-<pid>` on
  `127.0.0.1:55433` (database `electrical_e2e`)
- runs the suite
- removes the container when the run ends, whatever the outcome

It never touches any other container or database. The suite refuses to run against anything
except a loopback database whose name ends in `_e2e`, using the same rules as the API test guard
(`apps/api/test/setup/safety-rules.js`).

The app under test is started by Playwright on port **3100**, with:
- `STORAGE_DRIVER=local` (uploads go to a temp directory)
- email, alerting and AI credentials blanked
- generated placeholder secrets

Data is seeded per run (`global-setup.js`) through the shared scenario factories, with
generated, per-run credentials. Nothing real ever appears in a trace or report.

Reports are written to `e2e/reports/` (HTML, JUnit, JSON); traces and screenshots on failure go
to `e2e/test-results/`. Both are git-ignored. Open the HTML report with
`npm --prefix e2e run report`.

## Record a new test (codegen)

```
npm run dev                          # start the app locally on :3000 (your dev database)
npm run e2e:codegen                  # opens Chromium + the Playwright inspector on :3000
```

Codegen points at your **dev** server and dev data. Use what it records as a starting point only:
- replace any typed credential with values from `support/app.js#seed()`
- prefer `data-testid` / role locators
- never commit a recording that contains a real email, password or PIN

## Layout

- `playwright.config.js`: projects `chromium-desktop` and `chromium-mobile` (Pixel 7); retries
  1 in CI, 0 locally; trace and screenshot on failure only.
- `global-setup.js`: safety check, migrations, per-run seed → `.auth/seed.json`.
- `scripts/serve-app.js`: Playwright's `webServer` (safety check + migrations + `node index.js`).
- `scripts/run-e2e.js`: the root `npm run e2e` / `e2e:ui` runner (disposable database).
- `support/`: the database guard, seed and DB access, sign-in, the custom-select picker, test
  images and QR decoding.
- `tests/`: the specs.
  - `smoke.spec.js`: the environment smoke check, in both projects.
  - `journeys.spec.js`: J1–J7, desktop project only. J1–J6 are one ordered story (QR,
    guest complaint, electrician, supervisor, internal ticket), and the steps that happen
    on a phone open their own Pixel 7 context. J7 holds the negative cases (role, tenant,
    wrong PIN, invalid complaint). J9 (BUG-0018): the supervisor sends a fix back with a
    reason, the electrician sees it in their bell, redoes it, and is told when it is verified.
  - **BUG-0010 (in `journeys.spec.js`):** "electrician nav links work after module sync" and
    "supervisor nav links work after module sync".
    - **They wait** for `/api/auth/worker-me` (`/api/auth/me`) and the module sync, then
      assert every nav `href` is `/{org}/ele/{page}`.
    - **They click through the nav,** asserting a 200 at each target and the page heading.
    - **A link for a disabled module stays hidden.**
    - **Why:** the other journeys navigate with `page.goto`, so they never clicked the nav.
  - `*.mobile.spec.js`: phone-only journeys, run in `chromium-mobile` only. For example,
    J8 is the worker PIN reset from the emailed link.
  - `explorer.spec.js`: the explorer, an automated manual tester (below), in both projects.
  - `forms.spec.js`: every button and form the explorer does not press (it only follows links
    and tabs), desktop project only, in the explorer org. Each form gets an invalid submit (the
    server's or the page's error is shown, nothing changes), a valid one (the change shows and
    survives a reload) and its destructive actions (deactivate, delete, the 409 rules):
    electricians (create, edit, PIN, deactivate, delete), supervisors (duplicate email, password
    rule, delete with history → 409), assets, locations and alert rules (clearing a field on
    edit, BUG-0021), alert acknowledge, categories, templates, failures, the supervisor's asset
    events and failures (BUG-0024), duty roster and attendance (BUG-0025), a hand-typed QR code
    on both scan pages, a submitted inspection flagged by the admin, the scan page on a browser
    without BarcodeDetector (BUG-0022), and the super-admin's organization create / edit /
    module activation / enter / delete (BUG-0023).
  - `visual-a11y.spec.js`: the design and accessibility checks (below), in both projects.
- **Every journey checks two things:** what the user sees, and the database or API state
  behind it (through the app's own Prisma client). There are no fixed sleeps, only
  auto-waiting locators and `expect.poll`.

## The explorer (`tests/explorer.spec.js`)

It does what a manual tester does after every change: open every page as every role, click
every link, and look for anything broken. It runs in both projects (desktop and Pixel 7).

**Which pages, as which role**
- **The page list is the route table**, not a hand-typed list: `apps/api/src/routes/pages.js`
  exports `MODULE_PAGES` and `STATIC_PAGES`, and `support/explorer.js` adds the org home,
  module home and `offline.html`. One test fails if a `public/*.html` file is served by no
  route.
- **The role comes from the name:** `admin-*` admin, `supervisor-*` supervisor,
  `electrician-*` electrician, `superadmin-*` super-admin; `*-login` and everything else is a
  guest page.
- **The explorer org** (`global-setup.js`) has the assets module on, so the asset pages and
  their nav links exist. It has one admin, supervisor and electrician, a QR room, an open
  ticket, a resolved ticket with a pending review link, an asset with a failure, and a
  default inspection template. The super-admin is the seed's. `supervisor-electrical` is
  opened with a location (without one it sends the user to the scan page, by design).

**What happens on each page**
1. **Open it** signed in as the role, and wait for the auth/module sync
   (`localStorage.enabledModules`, which an init script clears on every load — the BUG-0010
   technique).
2. **Click its `[role=tab]` controls** in place.
3. **Follow every visible same-origin link** one hop (a collapsed phone menu counts as
   visible). Each target is followed once per role and project. Logout links are skipped,
   and `/api/…` links are fetched rather than opened. **It never clicks a button**, so it
   never submits, deletes or signs out.

**Checks on every page and every followed link**

| Check | Fails when |
|---|---|
| `document` | the page does not answer 200 |
| `landed` | a signed-in role ends up on a login page |
| `sync` | the module sync did not finish |
| `loading` | a skeleton, spinner or "Loading…" stays on screen |
| `requests` | a same-origin request answers ≥ 400 or fails |
| `console` | a console error or an uncaught exception |
| `errorText` | "not found" / "Route GET … not found" on the page |
| `images` | a broken `<img>` |
| `slug` | a link carries the org slug twice (BUG-0010, BUG-0011) |
| `overflow` | phone only: the page is wider than the viewport |
| `axe` | a critical accessibility violation (pages opened directly) |
| `rawValue` | "undefined" or "NaN" is visible: a field the page reads but never gets (BUG-0012) |
| `nav` | admin pages: fewer than 5 nav links, or (desktop) two nav links touching on one line, an unstyled nav (BUG-0013) |

Two things are deliberately not findings:
- **An empty `throw ''` when the visit was redirected.** The pages stop their own script
  with `location.href = …; throw ''` (24 pages). Anywhere else it is reported.
- **The CSP error axe causes.** axe-core fetches cross-origin stylesheets itself, which the
  app's `connect-src 'self'` rightly blocks, so console errors are collected before axe runs.

**The forbidden matrix.** For each role, every page of the other roles must send the user
to a login page (the super-admin, on admin pages, to its own dashboard), never show the page.
These tests block `/api/**`: the redirect is decided in the browser, and blocking keeps ~100
login-page loads off the per-address rate limits.

**The allow-list (`explorer-allowlist.json`)**
- **What it is:** pre-existing findings that are reported but don't fail the run. Each entry
  is `{ role, page, check, match?, finding, reason }`, where `finding` is the id in
  `docs/testing/COVERAGE_MATRIX.md`.
- **It may only shrink.** Fix the defect, delete the entry. Never add one to make a new
  failure go away; a new finding is a bug to fix.
- **"Remove me":** `scripts/summarize.js` prints an entry that matched nothing on pages that
  were explored.
- **BUG-0010 / BUG-0011** (the org slug twice in a link) are never listed.
- **Today: empty.** F16 (unlabelled controls on 7 pages) and F17 (phone overflow on
  admin-assets, admin-electrical and admin-failures) were fixed on 2026-10-18 and their
  entries deleted.

**Results.** Every visit is an `explorer` annotation. `scripts/summarize.js` turns them
into `explorer` in `e2e-summary.json`:
- `desktop` / `mobile`: one row per role × page, `{ role, page, status, failed, allowed,
  links, linkFailures, tabs }`;
- `forbidden`: per project and role, how many pages were checked and which were shown;
- `allowlist`: the entry count and the unused entries.

**Rate limits.** The explorer adds one admin and one supervisor API login to a run
(`/api/auth/login` allows 10 per 15 minutes per address; the run uses 9). The electrician
login is cached for the run (`workerLogin()`).

## Design and accessibility checks (`tests/visual-a11y.spec.js`)

**Every page**, checked on desktop and on Pixel 7. The page list is the explorer's
(`support/explorer.js`, from the route table), so a new page gets a screenshot check and an
axe scan automatically: 42 pages, 84 page views.

The pages show a dedicated "visual" org (`e2e-visual`) with fixed names, codes, dates and
data:
- the assets module is on;
- one admin, supervisor and electrician;
- a QR room;
- open, in-progress and resolved tickets (with a fixed review link);
- an asset with a failure;
- a default inspection template.

Every fixture row is dated, and every page's clock is frozen, at 2026-01-15 10:00 IST. So
the screenshots don't depend on the per-run seed or on the day the suite runs. The
super-admin pages use the seed's super-admin, whose cached session keeps the run inside
the login limit.

**Visual (`toHaveScreenshot`, `support/visual.js`)**
- **What's masked:** times, dates and relative times; `<canvas>`; and per-page regions that
  differ by run however the data is fixed:
  - **admin-dashboard, admin-analytics:** the charts (`svg`);
  - **admin-predictions:** the 12-week trend, whose week labels come from the server's date;
  - **super-admin pages:** the signed-in name and initials;
  - **superadmin-dashboard:** the platform-wide numbers;
  - **superadmin-quality:** the trend.
- **What's fixed instead of masked:** content that depends on "now" or on a live feed gets a
  fixed input, which is preferred over hiding it.
  - **every page:** the page clock is frozen (`page.clock.setFixedTime`), and the fixtures
    carry fixed dates;
  - **superadmin-quality:** `/api/superadmin/qa/ci-status` is answered with three fixed runs
    (`page.route`);
  - **superadmin-dashboard:** the organization list (which would hold every e2e org of the
    run) is answered with two fixed organizations.
- **Where baselines live:** `tests/__screenshots__/<platform>/<project>/<page>.png`. The file
  name is the explorer's page name, made file-safe (`scan (/scan/:code)` →
  `scan-scan-code.png`).
- **Only Linux baselines are ever committed.** The Windows and macOS directories are
  git-ignored.
- **Until a baseline exists for the current platform**, the check records an annotation
  `no baseline: <page>`, attaches the masked screenshot, and does **not** fail.
- **On a mismatch:** the `e2e-traces` artifact keeps the expected, actual and diff images,
  and the Quality page's Design tab names the page and links to the artifact.
- **Creating or refreshing baselines:**
  1. Run the **E2E** workflow by hand with `update_snapshots` = `true` on the branch.
  2. Download the `e2e-snapshots-linux` artifact.
  3. Review every changed image.
  4. Commit them under `e2e/tests/__screenshots__/linux/`, and only the ones the change
     meant to alter.
- **Checking a page is deterministic locally:** run the visual tests twice in one copy,
  first with `--update-snapshots` (this writes git-ignored local baselines), then without.
  The second run starts from a new database and must pass.

**Accessibility (axe-core, WCAG 2.0/2.1 A + AA)**
- **It fails only on critical violations.** The exception is an F16 page: the explorer's
  allow-list (`explorer-allowlist.json`, `axe`) has its critical findings, which are
  reported as `axe-known`, not failed. The allow-list may only shrink.
- **What's recorded:**
  - counts per impact (`axe` annotation);
  - nodes per rule (`axe-rules` annotation; the contrast ratchet sums these);
  - an attachment with rule ids, help text and selectors only.
- **Node HTML is left out on purpose:** it could carry an `?token=` image URL into a public
  artifact.
- **The summary** (`e2e-summary.json` `pages[]`) carries `axe`, `axeRules` and `known` per
  page view.

## Design ratchets (`apps/api/scripts/design-ratchet.js`, `design-baseline.json`)

Two counts that may only go down. A check fails only when its count is **worse** than the
committed baseline. When it is lower, `--update` writes the lower number. Never raise a
baseline to make a check pass.

| Ratchet | Counts | Runs in |
|---|---|---|
| **Colour literals** | hard-coded colours (hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`) in `apps/api/public/**/*.html` and `public/css/**`. Not counted: design-token definitions (`:root { … }` and any `--name: …` custom property), selectors, `href="#"` and entities | `npm run ci` (ci-validate) |
| **Colour contrast** | axe `color-contrast` nodes over every page and viewport of the run | `e2e.yml`, after the suite |

```
cd apps/api
node scripts/design-ratchet.js colours            # lists the files when it fails
node scripts/design-ratchet.js colours --update   # after removing literals
node scripts/design-ratchet.js contrast ../../e2e/reports/e2e-summary.json [--update]
```

The current numbers are in `design-baseline.json`, and the Quality page's Design tab shows
the latest run's. A partial run (`--grep`) records the contrast count as `partial`, because
only a full run is comparable.

## Production smoke (`prod-smoke.config.js`, `tests-prod/`)

A separate, read-only suite that runs against a **deployed** site, not the local app
([ADR 0009](../docs/adr/0009-post-deploy-production-smoke.md)). It has no web server, no
database and no seed, and it signs in nowhere. CI runs it after every production deploy,
nightly and by hand (`.github/workflows/prod-smoke.yml`).

```
cd e2e
PROD_SMOKE_URL=https://example.com PROD_SMOKE_ORG_SLUG=<org> npx playwright test -c prod-smoke.config.js
node scripts/prod-smoke-summary.js     # reports/prod-smoke-summary.json, incl. the methods requested
```

- **What it checks:** `/health/ready`; every public and login page of the organization (200,
  no console error, no failed same-origin request); the static assets those pages link;
  security headers; http → https.
- **GET and HEAD only, enforced:**
  - every browser request passes `context.route('**/*')`, and any other method is aborted
    and fails the test;
  - direct checks can only call `get`/`head`, and service workers are blocked;
  - each test records the methods it requested (a `methods` annotation), and the summary adds
    them up (`methods`, `readOnly`).
- **Never point it at a site you may not load.** It only reads, but it is real traffic.

## CI (`.github/workflows/e2e.yml`)

**When it runs**
- on every pull request. The required check `e2e` always exists: a first job (`e2e — what
  changed`) looks at the PR's files, and when none is under `apps/api/**`, `e2e/**` or the
  workflow, `e2e` passes in seconds without running the suite
- nightly at 21:30 UTC (03:00 IST)
- by hand (inputs `update_snapshots`, `requested_by`)
- from the super-admin Quality page's **Run full test suite now** button, which dispatches
  it on `main`

**What it does**
1. **Three shards in parallel** (`e2e shard i/3`). Each starts its own Postgres 15 service
   (`electrical_e2e` on 127.0.0.1), runs `npm ci` for the app and for `e2e/`, installs
   Chromium (the browser download is cached per Playwright version), and runs
   `npx playwright test --shard=i/3 --reporter=blob`, retrying once.
   - `explorer.spec.js` and `visual-a11y.spec.js` are `mode: 'parallel'`, so the shards
     can split them.
   - `journeys.spec.js` is one ordered story and stays in one shard.
   - `workers` stays 1 inside each shard.
2. **The job named `e2e`** merges the three blob reports with
   `npx playwright merge-reports --config merge.config.js`. The result is the same HTML,
   JUnit and `reports/results.json` a single run writes, so the summary, the contrast ratchet
   and the ingest are unchanged.
3. **The check is red** when a shard failed or was cancelled.

**What it produces**
- `scripts/summarize.js` writes `reports/e2e-summary.json` (counts, journeys, per-page axe
  and visual state, first-line failures).
- The `e2e-report` artifact is always uploaded and kept 7 days.
- The `e2e-traces` artifact (all shards' `test-results/`) is uploaded on failure only and
  kept 7 days.
- With `update_snapshots`, the `e2e-snapshots-linux` artifact holds the committed baselines
  with every shard's new or changed ones laid over them. Each shard uploads only what it
  wrote, so none can overwrite another's with a stale copy.
- The summary is posted to `POST /api/qa/runs` with `source: 'e2e'`, for the Quality page's
  End-to-end tab. This step is best-effort: it skips when `QA_INGEST_URL`/`QA_INGEST_TOKEN`
  are unset and prints only the HTTP status.

The deploy workflow is separate, and this one never deploys.
