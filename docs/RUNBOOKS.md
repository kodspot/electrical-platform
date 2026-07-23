# Incident Runbooks

Pre-written responses to the failure modes worth planning for. Each is: **symptom →
diagnose → act**. For the mechanisms behind these behaviors see
[`architecture/resilience.md`](architecture/resilience.md); for what healthy looks like see
[`MONITORING.md`](MONITORING.md).

Keep these short and honest. A runbook nobody can follow under pressure is worse than none.

## Roll back a bad deploy

**Symptom:** a deploy completed but the app is misbehaving, or the deploy's health-check
loop failed and the new container never became healthy.

**Diagnose:** `docker compose logs --tail 150 api` on the production host; check
`GET /health/ready`.

**Act:** the deploy is a `git pull` + `docker compose build && up -d` (see
[`DEPLOYMENT.md`](DEPLOYMENT.md)). To roll back, on the production host: check out the last
known-good commit (`git reset --hard <sha>` or `git checkout <sha>`), then re-run
`docker compose build && docker compose up -d` and wait for `/health/ready` to report
`200`. Because the deploy is image-rebuild-from-source, rolling code back and rebuilding
*is* the rollback — there is no separate artifact to revert. A schema migration is **not**
auto-reverted; if the bad deploy included one, consult the migration's rollback approach
(Charter §15) before rolling code back past it.

## Database outage or degradation

**Symptom:** `/health/ready` returns `503` (`database: disconnected`); requests failing;
`circuitBreakers.database.state` trending to `OPEN`.

**Diagnose:** is the `db` container up and healthy? `docker compose ps db`;
`docker compose logs db`. Check disk space on the host (a full disk stops PostgreSQL).

**Act:** the app is designed to survive this gracefully — `dbBreaker` fast-fails requests
instead of piling them onto a down database, and `connectWithRetry` reconnects with backoff
when the database returns (see [`architecture/resilience.md`](architecture/resilience.md)).
So the priority is restoring PostgreSQL, not restarting the app: bring `db` back
(`docker compose up -d db`), free disk if needed, and the API recovers on its own as the
breaker half-opens and probes succeed. If data is lost or corrupted, follow
[`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).

## AI provider outage

**Symptom:** AI chat/analysis endpoints return `502`/`503`; `circuitBreakers.aiProvider.state`
is `OPEN`; daily AI insights stop generating.

**Diagnose:** this is usually **external** (the provider is down, a key expired, or a rate
limit is hit) — check the org's configured provider/key and the provider's status page.

**Act:** no server action is required to protect the system — `aiBreaker` opening is the
intended behavior; it stops hammering a down provider and lets the rest of the app run
normally (AI is an optional enhancement, not on any critical path). Insights skip the
affected ticks and catch up on the next scheduled run. If a specific org's key is the
problem, that org updates it in its AI settings; if a global fallback key is used
(`GLOBAL_AI_*`), rotate it in the production secrets.

## R2 / offsite-backup failure

**Symptom:** image uploads fail, or `node apps/api/scripts/backup-r2.js list` returns
`403 Access Denied`.

**Diagnose:** because the application's image uploads and the backup script share the same
R2 credentials, a `403` on one implies the other is affected too. This exact failure is a
**known open risk** as of 2026-07 (finding C2,
[`history/production-readiness-audit-2026-07.md`](history/production-readiness-audit-2026-07.md)).

**Act:** verify the R2 API token's bucket-scoped read/write permissions in the Cloudflare
dashboard and confirm `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in the
production `.env` are current. Re-test with `backup-r2.js list`. Full backup/restore
procedure: [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md).

## Scheduler stuck or duplicated across instances

**Symptom:** scheduled jobs (cleanup, alerts, insights) not running, or — if more than one
instance is deployed — appearing to run twice.

**Diagnose:** scheduled jobs are guarded by PostgreSQL advisory locks
([`architecture/resilience.md`](architecture/resilience.md)); "another instance is already
running lock N" at `warn` level is **normal** coordination, not an error. A skipped tick is
caught by the next interval by design.

**Act:** for a single instance, restart the `api` container to restart the schedulers. The
lock design means you do not need to worry about a restart causing duplicate runs — the
locks coordinate correctly across a restart or across multiple instances.

## Related

- [`MONITORING.md`](MONITORING.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
  [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) ·
  [`architecture/resilience.md`](architecture/resilience.md)
- Rollback policy: [`ENGINEERING_CHARTER.md`](ENGINEERING_CHARTER.md) §15
