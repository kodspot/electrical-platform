# Testing: what runs when

Every check the project runs automatically, when it runs, and where its result appears. All
of it is free (GitHub-hosted runners, no paid service) and deterministic (no AI). Results
land on the super-admin **Quality** page (`/superadmin-quality`) through the QA ingest
(`POST /api/qa/runs`, [ADR 0005](../adr/0005-qa-telemetry-in-production.md)).

| When | Workflow / job | What it checks | Fails the build? | On the Quality page |
|---|---|---|---|---|
| Every PR, every push to `main` | `deploy.yml` › **Lint & Test** (Node 24) | `npm run ci`: lint, the API suite (unit + integration, on a disposable Postgres), repository checks (`ci-validate`: structure, env, migrations, schema drift, generated docs); dependency audit gate; backup script tests; Docker image smoke test | yes | Unit & integration (source `ci`) |
| Every PR, every push to `main` | `deploy.yml` › **Lint & Test (Node 22, report-only)** | the same `npm run ci` on Node 22 | no | — |
| Every PR touching `apps/api/**` or `e2e/**`; nightly 21:30 UTC; by hand; the Quality page's "Run full test suite now" | `e2e.yml` | the browser suite ([`e2e/README.md`](../../e2e/README.md)): journeys J1–J8, the BUG-0010 nav tests, the **explorer** (every page × every role × desktop + phone, every link), the design/accessibility checks | yes | End-to-end (source `e2e`) |
| Every PR | `change-impact.yml` | the **change impact report** (below) | never | Changes (source `impact`) |
| Push to `main`, after Lint & Test | `deploy.yml` › **Deploy to Production** | deploys; no test of its own | — | — |
| Push to `staging` | `deploy-staging.yml` | the same gate as production, then a staging deploy (inert until a staging host exists) | yes | — |

Locally: `npm run ci` (the full gate), `npm run e2e` (the browser suite on a disposable
database), `npm run bug:test` (the bug registry). See [`apps/api/README.md`](../../apps/api/README.md).

## The change impact report (`apps/api/scripts/change-impact.js`)

On every pull request a comment answers: *what did this change touch, and is it tested?*
There is one comment per PR, marked `<!-- change-impact -->` and updated in place on every
push.

**From changed file to affected item**

| Changed file | Affected |
|---|---|
| `apps/api/public/<page>.html` | that page |
| `apps/api/public/js/<f>.js`, `public/css/<f>` | every page that loads it (`app.js` and the design system: all of them) |
| `apps/api/public/sw.js` | every page |
| `apps/api/src/routes/<f>.js` | its routes (as listed in [`routes.generated.md`](../reference/routes.generated.md)) and the pages whose code calls them |
| `apps/api/src/{services,lib,middleware,plugins}/<f>.js` | the routes of every route file that requires it |
| `apps/api/prisma/schema.prisma`, `prisma/migrations/<m>/` | the data model, that migration |
| tests, `apps/api/scripts/` (tooling), `infrastructure/` and compose files (deployment), `.github/`, docs | listed under "Other files"; no runtime impact |

**Coverage.** For each affected item it lists the tests that mention it: browser journeys,
the explorer and the visual checks (`e2e/tests/`), the API suite (`apps/api/test/`, except
this tool's own test, whose fixtures mention paths), and the bug registry
(`apps/api/scenarios/bugs/`).
- **A page** is covered when a spec names it. The explorer covers every page of the route
  table.
- **A route** is covered when a test uses its path (`:id` matches any interpolated value).
  The match is by path, not by method.
- **The data model** is covered by the schema-drift gate.
- **An item no test mentions** is listed under **⚠️ Changed but not covered.** That is a
  prompt for the reviewer, not a failure.

**Limits, on purpose.** It is a text search, not a call graph. A test that builds a path by
string concatenation is not found (a false "not covered"), and a page that merely mentions
a path counts as calling it. It never fails the build: the job is `continue-on-error`, and
the script exits 0 even when git cannot answer.

**Where it goes.**
- **The PR comment** is posted with the workflow's `GITHUB_TOKEN` (`pull-requests: write`).
  Fork PRs get a read-only token, so they get no comment.
- **The QA ingest** receives it as source `impact`, best-effort. It is skipped when
  `QA_INGEST_URL`/`QA_INGEST_TOKEN` are unset, and only the HTTP status is printed. Until
  the ingest accepts the `impact` source, it answers 400; the comment is unaffected.
