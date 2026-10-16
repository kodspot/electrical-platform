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
    wrong PIN, invalid complaint).
  - **BUG-0010 (in `journeys.spec.js`):** "electrician nav links work after module sync" and
    "supervisor nav links work after module sync".
    - **They wait** for `/api/auth/worker-me` (`/api/auth/me`) and the module sync, then
      assert every nav `href` is `/{org}/ele/{page}`.
    - **They click through the nav,** asserting a 200 at each target and the page heading.
    - **A link for a disabled module stays hidden.**
    - **Why:** the other journeys navigate with `page.goto`, so they never clicked the nav.
  - `*.mobile.spec.js`: phone-only journeys, run in `chromium-mobile` only. For example,
    J8 is the worker PIN reset from the emailed link.
  - `visual-a11y.spec.js`: the design and accessibility checks (below), in both projects.
- **Every journey checks two things:** what the user sees, and the database or API state
  behind it (through the app's own Prisma client). There are no fixed sleeps, only
  auto-waiting locators and `expect.poll`.

## Design and accessibility checks (`tests/visual-a11y.spec.js`)

There are 10 pages, each checked on desktop and on Pixel 7:
- the admin, supervisor and electrician logins
- the admin dashboard, tickets, locations and QR print pages
- the guest complaint page (`/s/<code>`)
- the electrician's My Work page
- `/superadmin-quality`

The pages show a dedicated "visual" org with fixed names, codes and tickets, so the
screenshots don't depend on the per-run seed.

**Visual (`toHaveScreenshot`, `support/visual.js`)**
- **What's masked:** times, dates and relative times; `<canvas>`; and per-page dynamic
  regions such as the dashboard charts and the Quality page's trend.
- **What's fixed instead of masked:** content that depends on "now" or on a live feed gets a
  fixed input, which is preferred over hiding it.
  - **admin-dashboard:** the page clock is frozen (`page.clock.setFixedTime`), so the
    date picker always shows the same date.
  - **superadmin-quality:** `/api/superadmin/qa/ci-status` is answered with a fixed
    response (`page.route`), so the Live CI list renders three known runs at a fixed height.
- **Where baselines live:** `tests/__screenshots__/<platform>/<project>/<page>.png`.
- **Only Linux baselines are ever committed.** The Windows and macOS directories are
  git-ignored.
- **Until a baseline exists for the current platform**, the check records an annotation
  `no baseline: <page>`, attaches the masked screenshot, and does **not** fail.
- **Creating or refreshing baselines:**
  1. Run the **E2E** workflow by hand with `update_snapshots` = `true`.
  2. Download the `e2e-snapshots-linux` artifact.
  3. Review the images.
  4. Commit them under `e2e/tests/__screenshots__/linux/`.

**Accessibility (axe-core, WCAG 2.0/2.1 A + AA)**
- It's report-only, and the test fails **only on critical violations**.
- Counts per impact are recorded as an `axe` annotation, plus an attachment that holds rule
  ids, help text and selectors only. Node HTML is left out on purpose: it could carry an
  `?token=` image URL into a public artifact.

**Baseline counts (2026-10-13, after fixing the one critical finding).** The critical finding
was `button-name` on the mobile menu button `#nav-toggle` on 11 admin pages, which now
carries `aria-label="Menu"`. Cells show serious-violation nodes, desktop / mobile; critical
is 0 everywhere:

| Page | Serious |
|---|---|
| admin-login, supervisor-login, electrician-login | 0 / 0 |
| admin-dashboard | 4 / 4 |
| admin-tickets | 5 / 1 |
| admin-locations | 3 / 3 |
| admin-qr-print | 0 / 0 |
| guest-complaint | 2 / 2 |
| electrician-my-work | 1 / 1 |
| superadmin-quality | 10 / 9 |

By rule, across both projects:
- `color-contrast`: 24 nodes
- `link-in-text-block`: 20 nodes
- `scrollable-region-focusable`: 1 node

These are known, report-only items for a later design pass. A new critical violation fails
the suite.

## CI (`.github/workflows/e2e.yml`)

**When it runs**
- on every pull request that touches `apps/api/**`, `e2e/**` or the workflow, with no
  branch filter, so stacked PRs run too
- nightly at 21:30 UTC (03:00 IST)
- by hand (inputs `update_snapshots`, `requested_by`)
- from the super-admin Quality page's **Run full test suite now** button, which dispatches
  it on `main`

**What it does**
1. Starts Postgres 15 as a service (`electrical_e2e` on 127.0.0.1).
2. Installs Node 22, then runs `npm ci` for the app and for `e2e/`, plus
   `playwright install --with-deps chromium`.
3. Runs `npx playwright test`, retrying once in CI.

**What it produces**
- `scripts/summarize.js` writes `reports/e2e-summary.json` (counts, journeys, per-page axe
  and visual state, first-line failures).
- The `e2e-report` artifact is always uploaded and kept 7 days.
- The `e2e-traces` artifact is uploaded on failure only and kept 7 days.
- With `update_snapshots`, the `e2e-snapshots-linux` artifact holds the new baselines.
- The summary is posted to `POST /api/qa/runs` with `source: 'e2e'`, for the Quality page's
  End-to-end tab. This step is best-effort: it skips when `QA_INGEST_URL`/`QA_INGEST_TOKEN`
  are unset and prints only the HTTP status.

The deploy workflow is separate, and this one never deploys.
