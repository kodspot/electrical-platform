# Audit Playbook

How to repeat the UI/UX, security, DPDP and future-readiness audit, so the next one starts
from the last one instead of from nothing. The first run is recorded in
[`history/audit-2026-11.md`](history/audit-2026-11.md).

Run it before a major release, after a change to how personal data is handled, and at least
once a year. The whole run can be done by one engineer, or by Claude Code with the saved
workflow.

## Ground rules

- **Read-only until a finding is confirmed.** Every finding names a `file:line` and a real
  failure. A suspicion that cannot be shown in this code is not a finding.
- **Try to refute each finding before fixing it.** Most scanner hits are false alarms: the
  first run's tenancy scan listed 222 calls, and none was a real gap.
- **Fix test-first** (`CLAUDE.md`, "How to work"). Show the test failing on the old code, and
  check that it fails for the right reason. In the first run, a test passed on the old page
  because the new shared code had already fixed it, so the old shared files must be
  restored too.
- **Every fixed defect enters the bug registry.**
- **Never touch production data, containers or credentials.** Tests run in a disposable copy
  against a disposable database.
- **Do not re-report what the owner has deferred:** Telegram and webhook alert channels,
  ticket SLA timers and escalation, and the iPhone camera QR fallback.
- **Business and legal questions go to the owner,** with a recommendation. They are not
  decided in code.

## Step 1: UI and UX

```sh
npm run audit:render -- --label before     # screenshots + axe, every page, desktop and phone
# make the changes
npm run audit:render -- --label after --before before
npm run audit:digest                       # a short text digest of each page, for review
```

Output goes to `e2e/reports/render/<label>/`: screenshots, `axe.json`, `summary.json`, and
`changed.txt` when `--before` is given. It works in a temporary copy, so it never rewrites
the Linux visual baselines.

Review each page as the person who uses it: a resident on a phone, an electrician in a dim
room on a weak signal, a supervisor mid-round, an admin on the first day.

Check especially:

- Every required control can be reached by touch and by keyboard. A browser test must use a
  real click: `setInputFiles` works on a hidden input, and that is how BUG-0062 reached
  production.
- A failed request never reads as an empty list.
- Every error appears on screen, in words the person can act on.
- Nothing depends on a colour alone. Touch targets are at least 44px, text at least 12px.

The design ratchet (`node scripts/design-ratchet.js colours`, from `apps/api`) may only go
down. Do not lower the contrast baseline from Windows numbers: CI counts on Linux.

## Step 2: Security

```sh
npm run audit:tenancy      # prisma calls with no orgId in their where clause
npm run audit:escaping     # free text concatenated into HTML without esc()
cd apps/api && npm audit --omit=dev
```

Then read each area with these questions:

| Area | Where | What to confirm |
|---|---|---|
| Tenant isolation | `src/routes/*` | A bare-`id` mutation follows an `orgId`-scoped check; another org's record answers 404 |
| Authentication | `routes/auth.js`, `worker-auth.js`, `middleware/auth.js` | HS256 pinned, expiry set, `tokenInvalidBefore` honoured, reset tokens hashed and single-use |
| Authorization | `requirePolicy` / `requireModule` on each route | Every new route is gated; a supervisor or electrician cannot reach admin data |
| Public surface | `routes/public.js`, `images.js` | Rate limits, validated input, upload signatures, the org check on image keys |
| Client IP | `index.js`, `infrastructure/Caddyfile` | The API port is not published; Caddy sets `X-Forwarded-For` itself |
| Output | `public/*.html`, `public/js/*` | `esc()` for HTML, `App.escJs` for inline handlers, CSV formula guards on every export |
| AI | `routes/ai.js`, `services/automation.js` | No person's name or contact detail in a prompt; replies are escaped before rendering |
| Logs | `lib/log-redaction.js` | No credential or contact detail in a log line |
| Infrastructure | `Dockerfile`, `docker-compose.yml`, workflows | Non-root, no secret in the image, action versions pinned |

## Step 3: DPDP

Check [`reference/personal-data-inventory.md`](reference/personal-data-inventory.md) against
`apps/api/prisma/schema.prisma`, and
[`reference/dpdp-requirements.md`](reference/dpdp-requirements.md) against the law as it then
stands. The Rules phase in on about 13 to 14 May 2027: re-check the dates and read the Gazette
text directly, because the first run could only reach commentary on the Rules.

Compare the privacy notice with the code, line by line. BUG-0075 was a notice that said 7 days
while the code kept photos 30. The test in that bug's scenario ties the two together; add one
for any other number the notice states.

This is an engineering check, not legal advice. Items marked for counsel stay open until a
lawyer has answered them.

## Step 4: Future readiness

Start from the open items in the last report and in
[`history/product-architecture-review-2026-10.md`](history/product-architecture-review-2026-10.md).
For each, ask whether the trigger for changing it has been reached. Check that a backup has been
restored recently ([`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md)), that the unbounded queries
still have limits, and that the deferred-items list still matches what the owner wants.

## Step 5: Record it

1. Write `docs/history/audit-YYYY-MM.md`, using the first report's sections: scope, what was
   checked and how, findings with what happened to each, owner decisions, what was not
   verified.
2. Update the inventory and the DPDP register.
3. Add the report to [`README.md`](README.md), and a `CHANGELOG.md` entry.
4. Run `npm run ci` and `npm run e2e`.

## With Claude Code

The same audit is saved as a workflow: thirteen focused auditors, a skeptic for each dimension
and each serious finding, a coverage critic, and triage.

```text
use a workflow: run the saved product-audit workflow with today = YYYY-MM-DD
```

It runs agents in parallel, so it spends a large amount of usage: an earlier fan-out exhausted
a 5-hour limit within minutes. Pass `scope: "security"`, `"dpdp"` or `"future"` for part of
it, and resume with the run id if it stops at a limit.
