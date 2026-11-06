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

**Symptom:** image uploads fail, the backup log shows `offsite upload failed`, or
`docker compose exec -T api node scripts/backup-r2.js list` (on the host, from the repository
directory) returns `403 Access Denied`.

**Diagnose:** because the application's image uploads and the backup script share the same
R2 credentials, a `403` on one implies the other is affected too. This exact failure is a
**known open risk** as of 2026-07 (finding C2,
[`history/production-readiness-audit-2026-07.md`](history/production-readiness-audit-2026-07.md)).

**Act:** verify the R2 API token's bucket-scoped read/write permissions in the Cloudflare
dashboard and confirm `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in the
production `.env` are current. Re-test with
`docker compose exec -T api node scripts/backup-r2.js list`. The host has no Node.js, so
the backup tooling always runs inside the app container. Full backup/restore
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

## Personal data breach

A breach is any unauthorized access to, or loss, change or disclosure of, personal data: a
stolen backup, a leaked token, a bug that showed one hostel another's records, a lost laptop
with a database copy. If in doubt, treat it as one and start the clock. This procedure follows
the DPDP Act s.8(6) and commentary on Rule 7; have counsel confirm it
([`reference/dpdp-requirements.md`](reference/dpdp-requirements.md)).

1. **Start the record.** Note the time you became aware. Everything below is timed from that
   moment. Add a row to the breach register (below).
2. **Contain.** Stop the leak without destroying evidence: rotate the exposed secret, disable
   the account, or take the feature down. To sign everyone out, rotate `JWT_SECRET`. Save logs
   before any restart.
3. **Assess.** Which organizations, which people, and which fields
   ([`reference/personal-data-inventory.md`](reference/personal-data-inventory.md)). Note whether
   encrypted fields were exposed with their key.
4. **Tell the organizations at once.** Kodspot probably acts as their processor, and they need
   to know to meet their own duty (AUD-11/01).
5. **Tell the Data Protection Board and the people affected, without delay.** Commentary on
   Rule 7 reports a first intimation without delay and a detailed report **within 72 hours**:
   causes, impact, mitigation, and what people were told. Tell the people affected in plain
   words: what happened, what it means for them, what was done, what they should do, and who to
   contact.
6. **Fix and verify.** Fix with a regression test and a bug registry entry.
7. **Review within two weeks.** Add what changed to the register, and update this procedure.

Contact point for all of this: `privacy@kodspot.in`.

**The breach register.** Keep it outside the repository, since it can hold sensitive detail,
in a private file the owner controls. The privacy notice says one is maintained. For each
event record: time aware, time contained, what happened, the data and people affected,
notifications sent and when, and the fix.

**Practise.** Walk through this once a year with a made-up event. It has not been exercised yet.

## Related

- [`MONITORING.md`](MONITORING.md) · [`DEPLOYMENT.md`](DEPLOYMENT.md) ·
  [`DISASTER_RECOVERY.md`](DISASTER_RECOVERY.md) ·
  [`architecture/resilience.md`](architecture/resilience.md)
- Rollback policy: [`ENGINEERING_CHARTER.md`](ENGINEERING_CHARTER.md) §15
