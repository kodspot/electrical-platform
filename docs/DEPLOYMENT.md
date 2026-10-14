# Deployment

See [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) for backup/restore strategy and the
restore drill record — this document covers the day-to-day deploy pipeline only.

## How it works today

Every push to `main`, and every pull request into **any** branch (so stacked PRs are tested
too), runs the **Lint & Test** job in
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): lint, then
the full test suite against a real, disposable PostgreSQL service container, including
every database-backed integration test — no tests are skipped in CI, since a database
is always available there. (This doc deliberately doesn't cite a specific test count —
it grows with nearly every change and a stale number here is worse than none.)

**The test job then runs the dependency audit gate** (`apps/api/scripts/audit-gate.js`,
[ADR 0007](adr/0007-dependency-audit-gate.md)):
- **It fails on** any high or critical runtime advisory not listed in
  [`.github/audit-exceptions.json`](../.github/audit-exceptions.json), and on any listed
  exception past its `expires` date.
- **It only warns** on a registry or network error, which never blocks a deploy.
- **When it fails:** upgrade the package, or add a dated exception (`ghsa`, `package`,
  `severity`, `reason` with reachability evidence, `owner`, `expires`). Fastify-chain
  exceptions may last at most 60 days; all others at most 30.

The **Deploy to Production** job only runs on a direct push to `main`, and only after
the test job has passed (`needs: test`). It never runs for pull requests. It SSHes into
the production AWS EC2 host, writes a fresh `.env` from GitHub Actions secrets, and
runs `docker compose build && docker compose up -d`, then polls `/health/ready` (not
the always-200 `/health`) until the container reports genuinely healthy before
declaring the deploy successful.

**Net effect: a broken change cannot reach production.** It will fail the test job and
the deploy job simply won't run. A pull request can never deploy, whatever branch it
targets: the deploy job is guarded by
`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`.

After the test gate, a best-effort step posts the run's scrubbed summary
(`apps/api/reports/test-summary.json`) to `POST /api/qa/runs` for the super-admin Quality
page. It uses the `QA_INGEST_URL` and `QA_INGEST_TOKEN` secrets, never fails the job, skips
when either secret is empty, and prints only the HTTP status. This repository is public, so
its logs are too.

**What a deploy prints.** If the API never becomes healthy, the deploy job prints the last
150 API log lines (credential-free, see `docs/MONITORING.md`) and fails. It then always
prints `docker compose ps caddy` (Caddy's container status). It does **not** print Caddy's
logs: Caddy's error log records request URIs, and the public run log is the wrong place for
them, even redacted. To read them, SSH into the host and run
`docker compose logs --tail 50 caddy`. The staging job prints nothing from Caddy. (C11)

**Caddy config check (every deploy, production and staging).** The deploy script runs
`docker compose down`, which removes every container, then `up -d`. So each deploy starts a
fresh Caddy that reads the `infrastructure/Caddyfile` just pulled, through its single-file
bind mount. After the API is healthy, the deploy then checks the running Caddy:
1. `docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile` must succeed.
2. `docker compose exec -T caddy caddy adapt --config /etc/caddy/Caddyfile | grep -c REDACTED`
   must be at least 1, which shows the credential log filter is live.

If either check fails, the deploy fails. Neither Caddy's logs nor the adapted config are
printed. The deployed commit is recorded in `~/.electrical-deployed-sha` (staging:
`~/.electrical-staging-deployed-sha`), outside the repository. The next deploy uses it to note
whether the Caddyfile changed. A manual `docker compose up -d` without `down` would **not**
recreate Caddy: after changing the Caddyfile by hand, run
`docker compose up -d --force-recreate --no-deps caddy`.

**The image is smoke-tested in CI before anything deploys** (ADR 0008). The Lint & Test job
builds `apps/api/Dockerfile` (Node 24), starts it with `NODE_ENV=production` against a fresh
database on the CI Postgres, and lets it run every migration. It then requires
`/health/ready` = 200, bootstraps the super-admin and signs in by email and password, and
stops it. Only HTTP statuses are printed. A report-only "Lint & Test (Node 22)" job runs the
same gate on the previous runtime for one release; it never blocks a deploy.

**Before merging a change that adds a migration** (for example F13's
`20261014000000_f13_module_defaults`), the owner confirms on the production host that the
database is up to date with the migrations already on `main`:

```bash
cd ~/electrical-platform && docker compose exec -T api npx prisma migrate status
```

- **"Database schema is up to date!"** — safe to merge. The deploy then applies the new
  migration.
- **"Following migration(s) have not yet been applied"** — an earlier deploy did not migrate.
  Investigate before merging.
- **"failed migrations" or "migrations not found locally"** — the history diverged. Do not
  merge; restore a backup into a scratch database first (`docs/DISASTER_RECOVERY.md`).

**Secrets that reach the server only through the deploy job:** besides the long-standing
ones, the deploy job passes `GIT_SHA` (`github.sha`), `IP_HASH_PEPPER`, `QA_INGEST_TOKEN` and
`GH_ACTIONS_DISPATCH_TOKEN` through the SSH step's `env`/`envs:` and the `.env` it writes.
`docker-compose.yml` hands them to the `api` container. See
[`reference/environment.md`](reference/environment.md).

## Staging

[`.github/workflows/deploy-staging.yml`](../.github/workflows/deploy-staging.yml)
mirrors the production workflow exactly — same test gate, same `docker-compose.yml`,
same deploy script shape — but triggers on push to a `staging` branch instead of
`main`, and uses a completely separate set of `STAGING_`-prefixed GitHub secrets, so
it cannot accidentally touch production credentials or the production host.

**This workflow is currently inert.** It's ready to use the moment two things exist:

1. **A staging host.** Recommended: a second, small Ubuntu 22.04 VM, provisioned with
   [`infrastructure/setup-vm.sh`](../infrastructure/setup-vm.sh) exactly like
   production was — nothing in that script is production-specific. Clone the repo to
   `~/electrical-platform-staging` on that host (the staging workflow's deploy script
   expects that exact path).
2. **The `STAGING_*` GitHub Actions secrets**, mirroring every secret the production
   workflow uses (`STAGING_AWS_HOST`, `STAGING_AWS_USERNAME`, `STAGING_AWS_SSH_PRIVATE_KEY`,
   `STAGING_DATABASE_URL`, `STAGING_JWT_SECRET`, etc. — see `deploy-staging.yml` for
   the full list). These should be genuinely different values from production's
   secrets, not copies — a staging environment sharing production's database or
   encryption key defeats the point of having one.

A dedicated staging host (rather than colocating staging and production containers on
one machine) is the recommended setup: `docker-compose.yml` binds Caddy to host ports
80/443, which only one Caddy instance can hold at a time, and a separate host gives
staging a faithful TLS/reverse-proxy setup rather than a workaround on alternate ports.

### Promotion flow, once staging is active

```
feature branch → PR against main (test job runs) → merge to main → production deploys
                                ↓ (optional, before merging)
                         push to `staging` branch → staging deploys → verify manually
```

A reasonable workflow: merge a feature into `staging` first, let it deploy and get
verified there, then fast-forward or merge `staging` into `main` to promote it to
production. Nothing in the current setup enforces this ordering — it's a team
convention to adopt once staging exists, not a technical gate.

## What changed and why (for anyone comparing against an older version of this doc)

- The Docker/compose healthchecks for the API container check `/health/ready`, not
  `/health` — `/health` always returns HTTP 200 even when the database is
  disconnected, so nothing that only checks the HTTP status code (which is exactly
  what `wget --spider` and Docker's `HEALTHCHECK` do) could previously detect a
  degraded instance. `/health` itself is unchanged, for backward compatibility with
  anything already depending on its always-200 behavior.
- `infrastructure/setup-vm.sh`'s header previously said "GCP VM" while the actual
  deploy target is AWS EC2 (see `deploy.yml`'s `AWS_HOST`/`AWS_USERNAME` secrets) —
  corrected. The script itself was never GCP-specific; only the comment was stale.
