# Kodspot Electrical Platform — API

Fastify + Prisma/PostgreSQL backend. See `docs/ENGINEERING_CHARTER.md` at the repository root for the engineering rules that govern every change to this codebase, and `docs/DEPLOYMENT.md` for how CI, production deploys, and staging fit together.

## Run locally (no cloud credentials needed)

The app runs entirely on your machine — the only external dependency is PostgreSQL, which a Docker container provides. Images are stored on the local filesystem, and email/AI no-op when unconfigured, so no cloud account is required. Run these from the **repository root**:

```
cp .env.dev.example .env                        # local config: STORAGE_DRIVER=local, localhost DB
docker compose -f docker-compose.dev.yml up -d  # PostgreSQL on 127.0.0.1:5432
npm run setup                                   # install deps, apply migrations, generate client
npm run seed                                    # load the demo organization + realistic data
npm run dev                                     # start the app (auto-reload) on http://localhost:3000
```

After `npm run seed`, sign in as the demo admin **`admin@demo.kodspot.test` / `DemoPass123`** (electrician PIN `1234`). `npm run doctor` at any time checks your environment and tells you exactly what to fix. Uploaded images land in the git-ignored `data/uploads/` directory (`STORAGE_DRIVER=local`), served through the same `/images/` proxy as production.

### Developer commands (run from the repository root)

| Command | Purpose |
|---|---|
| `npm run setup` | One-command bootstrap: install deps, apply migrations, generate the Prisma client. Idempotent. |
| `npm run seed` | Load the canonical demo dataset (the `demo` profile) — a full, deterministic demo org. **Local-only.** |
| `npm run demo` | Alias for `npm run seed demo` — the presentation-ready dataset for demos/onboarding. |
| `npm run scenario <name>` | Apply one named business scenario; `npm run scenario --list` lists them all. **Local-only** when applying. |
| `npm run dev` | Run the app locally with auto-reload. |
| `npm run doctor` | Read-only preflight — verifies env, database, and migrations; never changes anything. |
| `npm run verify` | Quick pre-commit gate: lint + full test suite + route-index drift check. |
| `npm run ci` | The full CI gate — the exact command CI runs: lint + full suite (incl. scenario & bug platforms) + repository/package/environment/migration/generated-doc safety checks. |
| `npm run release:check` | Deployment-readiness safety checks (structure, package, env, migrations, generated docs) — run before an intentional deploy. |
| `npm run reset` | Rebuild the local database from migrations **and re-seed** the demo data — the fastest path to a known state. **Local-only.** |
| `npm run clean` | Remove local uploaded images and logs. Never touches the database or `.env`. **Local-only.** |
| `npm run bug:list` | List the bug scenario registry — every fixed defect with a permanent reproduction (read-only). |
| `npm run bug:run -- <ID>` | Reproduce a bug's triggering state in the local database, to inspect it in `npm run dev`. **Local-only.** |
| `npm run bug:validate` | Reproduce every bug and assert its fix still holds (a regression check). **Local-only.** |
| `npm run bug:test` | Run the bug regression suite (the same checks, via `node --test`). |

Business scenarios live in [`apps/api/scenarios/`](scenarios/) and are the single source of truth reused by seeding, tests, and bug reproduction — they compose the shared factories in `apps/api/scenarios/factories.js`. The **bug reproduction library** ([`apps/api/scenarios/bugs/`](scenarios/bugs/)) builds on that system: every fixed defect is a reproducible scenario with a regression test, catalogued in [`docs/reference/bug-registry.generated.md`](../../docs/reference/bug-registry.generated.md). App-level commands (`test`, `lint`, `db:*`, `docs:routes`) live in `apps/api/`. See [`docs/reference/environment.md`](../../docs/reference/environment.md) for every environment variable, and [`docs/README.md`](../../docs/README.md) for the documentation index.

## Development

Install dependencies:

```
npm install
```

Run the automated test suite:

```
npm test
```

Unit tests (pure functions — crypto, password rules, module/status logic) and the HTTP-level app smoke tests run with no external dependencies. A second tier of integration tests (`test/integration/tenant-isolation.test.js`, `ticket-lifecycle.test.js`, `public-complaint.test.js`) requires a reachable `DATABASE_URL` and skips itself cleanly with a clear message if none is available — see `test/README.md` for the full tiering strategy.

Run a single test file (kept for backward compatibility with earlier tooling):

```
npm run test:phase1
```

Lint the backend source (`src/`, `test/`, `index.js`):

```
npm run lint
npm run lint:fix
```

Check or apply formatting:

```
npm run format:check
npm run format
```

`npm run format:check` currently reports style differences across the pre-existing codebase, which has not yet been run through Prettier. A full-codebase reformat is deliberately treated as its own separate, explicitly-reviewed change rather than bundled into any single feature or fix — see `docs/ENGINEERING_CHARTER.md` §4.

Linting and formatting are scoped to the backend (`src/`, `test/`, `index.js`); the frontend under `public/` is not yet covered by either tool.

## Local pre-push hook (opt-in)

A `pre-push` hook that runs lint + the full test suite before every push is available under `.githooks/` at the repository root, but is not active by default — see [`.githooks/README.md`](../../.githooks/README.md) for the one-time opt-in command.
