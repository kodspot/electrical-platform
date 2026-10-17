# 0009. A read-only production smoke after every deploy and nightly

- **Status:** Proposed
- **Date:** 2026-10-17
- **Deciders:** platform owner, engineering (QA-2)

## Context

Production was checked by hand after each deploy. The deploy job proved that the containers
came up and that Caddy's configuration was valid. It did not prove that the site a visitor
reaches works: pages answer 200, the login pages render without errors, the static assets
load, the security headers and the https redirect are in place. BUG-0010 reached production
with every test green, and the first report of it came from a user.

Constraints:
- **₹0 recurring cost.** GitHub-hosted runners only; no paid monitoring service, no AI.
- **No production writes.** Production is shared by every tenant, and a smoke test must not
  create, change or delete anything there, and must not sign in.
- **The repository is public.** Workflow logs and artifacts are world-readable.
- **No new service** ([ADR 0002](0002-modular-monolith.md)).

## Decision

We add a reusable workflow, `.github/workflows/prod-smoke.yml`. It runs:
- **after every deploy:** `deploy.yml` gains a job `smoke` (`needs: deploy`, `uses:` the
  workflow, `secrets: inherit`);
- **nightly** at 22:00 UTC;
- **by hand** (`workflow_dispatch`).

It runs a separate Playwright configuration, `e2e/prod-smoke.config.js`, against `APP_URL`,
for one organization (the repository variable `PROD_SMOKE_ORG_SLUG`). It has no web server,
no database and no seed.

**What it checks:**
- `/health/ready` is ok (polled for up to two minutes after a deploy);
- every public and login page of that organization returns 200 and renders in headless
  Chromium with no console error and no failed same-origin request;
- the linked static assets return 200;
- HSTS, `nosniff`, CSP, framing protection and the referrer policy are set;
- plain http redirects to https.

**The read-only rule is enforced, not intended:**
- **Browser requests:** every request passes `context.route('**/*')`. GET and HEAD
  continue; anything else is aborted, recorded and fails the run.
- **Direct checks:** they can only call GET or HEAD.
- **Service workers are blocked**, so no request escapes the guard.
- **The proof:** every request is counted by method before the guard decides, so a blocked
  one is counted too. The Production tab of the Quality page and the report show the counts
  (for example `GET 31, HEAD 0`).

**Results** go to the existing QA ingest as source `prod-smoke`. That is the job's one POST,
and it goes to the existing telemetry path ([ADR 0005](0005-qa-telemetry-in-production.md)),
not to application data. A failure alerts through the existing `ALERT_TELEGRAM_*` /
`ALERT_WEBHOOK_URL` channels when they are configured as repository secrets. The message
carries status only: the trigger and the run link. Without them, the run is just red.

The smoke never rolls a deploy back: it reports.

## Alternatives considered

- **Run the in-app production checks** (`POST /api/superadmin/qa/checks`, the Quality page's
  "Run production checks"). These are the only existing checks of the live system, but they
  need a super-admin sign-in and a POST, and they write an audit row. That breaks
  "anonymous, GET/HEAD only". They stay a manual action on the Quality page; no anonymous
  path was invented for them.
- **A paid or hosted uptime monitor.** It doesn't fit the ₹0 constraint, and it would check
  only one URL, not the pages, headers and assets.
- **A shell script with curl in `deploy.yml`.** It can't render a page, so console errors and
  failed sub-requests (BUG-0010's class of failure) would go unseen. It would also prove
  read-only behaviour by inspection only.
- **Signed-in checks with a dedicated production test account.** That needs a stored
  production credential, and every sign-in writes (session, audit, rate-limit state). It is
  rejected for this job. The authenticated paths are covered before deploy by the e2e suite
  and the explorer.
- **Run it inside the deploy job.** One failure would mix "the deploy failed" with "the site
  is unhealthy". A separate job, also callable nightly and by hand, keeps the two apart.

## Consequences

- **The deploy pipeline changes shape:** Lint & Test → Deploy → **Production smoke**. A red
  smoke marks the run red after a successful deploy; the deploy itself stands.
- **The owner must set `PROD_SMOKE_ORG_SLUG`** before the first run. Until then the job fails
  with a message naming the variable.
- **Every deploy and every night**, the smoke makes ~30 GET requests to production from a
  GitHub runner, including about six calls to the rate-limited `/api/org/:slug` (30 per
  minute per address). That is well inside the limits.
- **No authenticated page is checked in production.** Those are covered before deploy by the
  e2e suite and the explorer.
- **To reverse it:** delete the `smoke` job from `deploy.yml` and the workflow file. Nothing
  else depends on them.

## Related

- [`docs/testing/TESTING.md`](../testing/TESTING.md) (what runs when),
  [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md), [`docs/MONITORING.md`](../MONITORING.md).
- [ADR 0005](0005-qa-telemetry-in-production.md) (the QA ingest),
  [ADR 0006](0006-browser-e2e-with-playwright.md) (Playwright).
- Charter §6 (security), §22 (documentation).
