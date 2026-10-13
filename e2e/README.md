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
  - `*.mobile.spec.js`: phone-only journeys, run in `chromium-mobile` only. For example,
    J8 is the worker PIN reset from the emailed link.
- **Every journey checks two things:** what the user sees, and the database or API state
  behind it (through the app's own Prisma client). There are no fixed sleeps, only
  auto-waiting locators and `expect.poll`.
