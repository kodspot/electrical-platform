# Disaster Recovery

## Backup strategy

`infrastructure/backup-db.sh` runs daily at 2 AM IST via cron (installed by
`infrastructure/setup-vm.sh`). Each run:

1. Takes a `pg_dump` of the production database from inside the `electrical-db`
   container (`--clean --if-exists`, so a restore drops and recreates cleanly).
2. Gzips it to `/opt/kodspot-backups/kodspot_<timestamp>.sql.gz` on the production
   host.
3. Verifies the file is non-trivially sized (catches an obviously-failed dump).
4. **Uploads it offsite** to Cloudflare R2 under the `db-backups/` key prefix
   (`apps/api/scripts/backup-r2.js`) — see [ADR 0001](adr/0001-offsite-backup-storage.md)
   for why R2 was chosen.
5. Prunes local and offsite copies older than 14 days. Both prunes run even if the upload
   failed.

**Where the offsite steps run:** the production host has no Node.js, so `backup-db.sh`
runs the uploader **inside the app container**:
`docker compose exec -T api node scripts/backup-r2.js upload - <name> < <archive>`.
- **Credentials:** the container already has the R2 credentials (`env_file: .env`).
- **The archive** is streamed through stdin, so the container never mounts or reads the
  host's backup directory.
- **Exit status:** if the upload fails, the job logs `offsite upload failed` (no secrets),
  keeps the local archive, still prunes, and exits non-zero. If the dump fails, it exits
  non-zero before uploading or pruning anything.
- **Restores** stream the download the same way (`restore-db.sh --from-offsite`).
- **Tests:** `infrastructure/tests/backup-db.test.sh` and `backup-r2-stdio.test.sh`, run
  in CI.
- **Before 2026-10-14** the script called host `node` and failed on a host without it;
  the scripts were also committed without the executable bit.

**A local-only backup does not survive losing the host it protects — this is exactly
the failure mode the offsite step exists to close**, and it's the actual, motivating
finding behind this work package (Production Readiness Audit finding C6).

## 🔴 Known blocker: offsite upload is not currently functional

During the restore drill below, the offsite upload step failed with `403 Access
Denied` — confirmed to affect **every** operation (list, and a write to the same
`uploads/` prefix the application's own image-upload feature already uses), not just
backups specifically. This means the R2 credentials currently configured are not
valid for write access at all in this environment. **This must be resolved — by
checking the R2 API token's permissions in the Cloudflare dashboard and confirming
`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` in the real deployment's
`.env` are current — before offsite backups (or, notably, ordinary image uploads) can
be trusted to work in that environment.** This is a credentials/permissions issue
external to this codebase, not a bug in `backup-r2.js` — the code was verified
correct by exercising the exact same request shape the application's own working
`lib/r2.js` uses.

Once credentials are confirmed working, verify offsite upload independently, on the
production host, from the repository directory:

```bash
docker compose exec -T api node scripts/backup-r2.js list
```

**One-time verification after the 2026-10-14 change (owner).** On the production host, run a
real backup into a scratch directory, then confirm the new archive is listed offsite:

```bash
cd ~/electrical-platform && BACKUP_DIR=/tmp/kodspot-backup-check ./infrastructure/backup-db.sh; echo "exit=$?"
docker compose exec -T api node scripts/backup-r2.js list | head -3
```

Expect `exit=0`, "Backup job finished successfully", and the newest `db-backups/kodspot_<today>_…`
key at the top of the list. `exit=1` with `offsite upload failed` means the R2
credentials are the problem (see the known blocker above); the local archive is still
in `/tmp/kodspot-backup-check`. Afterwards, delete it: `rm -rf /tmp/kodspot-backup-check`.

## Restore runbook

```bash
# Restore from a local backup file into a specific container:
./infrastructure/restore-db.sh --target-container <name> --file <path/to/backup.sql.gz>

# Restore from the latest offsite backup (downloads it first):
./infrastructure/restore-db.sh --target-container <name> --from-offsite

# Restore a specific offsite backup by key:
./infrastructure/restore-db.sh --target-container <name> --from-offsite db-backups/kodspot_20260719_020000.sql.gz

# Add --yes to skip the confirmation prompt for scripted use.
```

`restore-db.sh` deliberately has **no default target** — `--target-container` is
always required, so it can never be run accidentally against the wrong database. It
prints a confirmation summary and requires typing `restore` before doing anything
destructive (or `--yes` to skip that, for drills/automation).

## Restore drill record

| Field | Value |
|---|---|
| Date | 2026-07-19 |
| Method | Real `pg_dump` from the actual running database, restored into a fresh, disposable Postgres container (staging environment does not exist yet — see [WP4's completion report](DEPLOYMENT.md) — this is the closest honest equivalent available) |
| Source data | 9 organizations, 34 tables, 4 tickets (actual local dev database at drill time) |
| Backup size | 24 KB |
| **Restore time (RTO, restore step only)** | **1 second** |
| Data integrity check | Table count (34), Organization count (9), and Ticket count (4) all matched exactly between source and restored copy |
| Functional verification | The real application (via Prisma, not raw SQL) was booted against the restored database; `/health/ready` reported `200 ok / connected`; an authenticated API route correctly exercised its full middleware stack against the restored schema |
| Offsite retrieval | **Not verified** — blocked by the R2 credential issue above; the drill used a local backup file directly |

**What this RTO number means, and doesn't mean:** 1 second reflects restoring today's
24 KB development database. Restore time scales with database size and is not a
promise for a much larger production dataset — re-run this drill periodically,
especially after significant data growth, and update this table with the new numbers
rather than treating this one measurement as permanent.

**Recovery Point Objective (RPO): up to 24 hours** — backups run once daily, so in the
worst case (an incident immediately before the next scheduled backup) up to a day of
writes could be lost. If this is not acceptable, the fix is running `backup-db.sh`
more frequently (it's already idempotent and safe to run more than once a day), not a
code change.

## Re-running the drill

The exact steps above are fully scripted and safe to repeat against a disposable
target at any time:

1. `BACKUP_DIR=/some/writable/dir ./infrastructure/backup-db.sh` (override `BACKUP_DIR`
   for a non-production host — it defaults to `/opt/kodspot-backups`).
2. Start a disposable Postgres container to restore into.
3. `./infrastructure/restore-db.sh --target-container <disposable> --file <backup> --yes`
4. Compare row/table counts against the source, and ideally boot the app against the
   restored database and check `/health/ready`.
5. Update the drill record table above with the new date and measurements.
