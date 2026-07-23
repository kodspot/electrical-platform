# Deployment

See [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) for backup/restore strategy and the
restore drill record — this document covers the day-to-day deploy pipeline only.

## How it works today

Every push to `main`, and every pull request against `main`, runs the **Lint & Test**
job in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): lint, then
the full test suite against a real, disposable PostgreSQL service container, including
every database-backed integration test — no tests are skipped in CI, since a database
is always available there. (This doc deliberately doesn't cite a specific test count —
it grows with nearly every change and a stale number here is worse than none.)

The **Deploy to Production** job only runs on a direct push to `main`, and only after
the test job has passed (`needs: test`). It never runs for pull requests. It SSHes into
the production AWS EC2 host, writes a fresh `.env` from GitHub Actions secrets, and
runs `docker compose build && docker compose up -d`, then polls `/health/ready` (not
the always-200 `/health`) until the container reports genuinely healthy before
declaring the deploy successful.

**Net effect: a broken change cannot reach production.** It will fail the test job and
the deploy job simply won't run.

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
