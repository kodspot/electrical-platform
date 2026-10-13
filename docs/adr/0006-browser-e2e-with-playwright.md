# 0006. Browser end-to-end tests with Playwright in a separate `e2e/` package

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** Engineering lead / architect, platform owner

## Context

The API suite (`apps/api/test/`, `node:test`) proves server behaviour, but nothing exercised
what the users actually touch:
- the QR → guest complaint → electrician → supervisor journey across three role apps
- the admin screens
- the mobile layout the electricians and guests use

The frontend is vanilla JS with no build step (Charter §5), so there is no component layer to
test in isolation: the only faithful test is a real browser against the real app.

Constraints:
- **The app's dependency set and lockfile (`apps/api/package-lock.json`) must not change**
  for test tooling.
- **The app runs on Node 20** (CI and the production Docker image). Current browser
  tooling requires Node ≥ 22.
- **The repository is public.** Test traces, screenshots and reports are downloadable, so they
  must never contain a real credential.
- **Visual baselines depend on the platform.** Font rendering differs on Windows, macOS and
  Linux, so a baseline from one fails on another.

## Decision

- **Tooling:** we use **Playwright** (`@playwright/test` 1.63.0, Apache-2.0) with
  **`@axe-core/playwright`** 4.13.0 (MPL-2.0, wrapping `axe-core` 4.13.0, MPL-2.0) for
  accessibility, and **`jsqr`** 1.4.0 (Apache-2.0) to decode QR codes. All are dev-only.
- **A separate package.** These live in a **separate package, `e2e/`**, with its own
  `package.json`, its own lockfile and `engines: node >= 22`. The app stays on Node 20, and
  only the e2e package and its CI workflow use Node 22+.
- **The app under test** is the real entry point (`node index.js`), started by Playwright's
  `webServer`:
  - `STORAGE_DRIVER=local`
  - SES/alert/AI credentials blanked
  - generated placeholder secrets
  - a disposable loopback database whose name must end in `_e2e`. This is enforced by
    importing the API suite's own safety rules (`apps/api/test/setup/safety-rules.js`), not a
    copy.
- **Data** is seeded per run through the shared scenario factories, with generated,
  per-run-unique credentials only.
- **Visual baselines** are generated only in CI on Linux and committed from the CI artifact.
  Windows and macOS baselines are git-ignored and never committed. Until baselines exist, the
  visual check reports "no baseline" instead of failing.
- **Accessibility (axe)** is report-only, failing only on `critical` violations, until a
  baseline is agreed.

## Alternatives considered

- **Put Playwright in `apps/api/`.** One package, but it changes the app's lockfile and
  production `npm ci` surface for test tooling, and would push the app to Node 22 before it
  is ready.
- **Cypress.** Mature, but weaker multi-context support: the journeys need a desktop admin, a
  phone guest and a phone electrician in one story. It also has heavier licensing terms for
  its parallel/dashboard features.
- **Puppeteer + a custom runner.** Lighter, but we would rebuild what Playwright already ships:
  retries, traces, HTML/JUnit reports, device emulation, visual comparisons, UI mode, codegen.
- **Selenium/WebDriver.** Slower and flakier for this scale, with no built-in visual or trace
  tooling.

## Consequences

- **CI gains a second workflow** (`e2e.yml`, Node 22) for PRs touching `apps/api/**` or
  `e2e/**`, plus a nightly run. It is separate from the deploy workflow and never deploys.
- **Artifacts are public.** The repository is public, so the report and traces (uploaded
  only on failure, kept 7 days) are world-readable.
  - This is acceptable because the app under test runs on a disposable database with
    secrets generated per run (`playwright.config.js`), so a trace holds no real
    credential.
  - The axe attachments carry selectors only, never node HTML.
- **Visual baselines are Linux-only and reviewed by a person.** The workflow, run with
  `update_snapshots`, uploads them as an artifact, and a person commits them.
- **There are two lockfiles to keep current.** `npm audit` for `e2e/` is separate from the
  app's.
- **Selectors:** journeys rely on stable `data-testid` hooks added to `public/`. Removing
  one breaks a journey on purpose.
- **Licences:** `axe-core` / `@axe-core/playwright` are MPL-2.0 (file-level copyleft). They are
  used only as unmodified dev tooling in CI and are never distributed with the product.
- **Reversing this** means deleting `e2e/`, its workflow and the root `e2e*` scripts. The app
  doesn't depend on any of it.

## Related

- [`../../e2e/README.md`](../../e2e/README.md): how to run, debug and record.
- [`../testing/COVERAGE_MATRIX.md`](../testing/COVERAGE_MATRIX.md): which journeys cover which
  workflows.
- ADR [0005](0005-qa-telemetry-in-production.md): the Quality page that shows e2e results.
