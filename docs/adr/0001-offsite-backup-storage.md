# ADR 0001: Offsite Backup Storage

**Status:** Accepted
**Date:** 2026-07-19

## Context

Production Readiness Audit finding C6: database backups existed only on the same
host they protect (`infrastructure/backup-db.sh` writing to `/opt/kodspot-backups`),
so losing that host would lose both the database and every backup of it simultaneously
— the exact scenario a backup exists to guard against.

## Decision

Upload each backup to **Cloudflare R2**, under a `db-backups/` key prefix, reusing the
same R2 account and credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`) the application already requires for image storage
(`apps/api/src/lib/r2.js`), rather than provisioning a separate provider (S3,
Backblaze B2, another R2 account, etc.).

An optional `R2_BACKUP_BUCKET_NAME` environment variable allows using a dedicated
bucket instead, falling back to the existing `R2_BUCKET_NAME` if unset — so this
works with zero new infrastructure by default, with a clean upgrade path to a
dedicated bucket later if wanted (e.g., for a different retention/lifecycle policy or
tighter access scoping than the image bucket needs).

Retention: 14 days offsite, matching the existing local retention window
(`RETENTION_DAYS` in `backup-db.sh`). Pruning both local and offsite backups on the
same schedule keeps the policy simple to reason about; they can be decoupled later if
a longer offsite retention is wanted without also keeping more local disk usage.

## Alternatives considered

- **A dedicated backup-only cloud provider/account** — more isolation (a compromised
  R2 token wouldn't threaten both images and backups), but requires provisioning and
  maintaining an entirely separate account/credential set for a single-VM deployment
  at this scale. Rejected for now as disproportionate; revisit if the R2 credential
  scope ever needs tightening for compliance reasons.
- **Cloud provider snapshot features (e.g., EBS snapshots on the EC2 host)** — would
  work but ties the backup mechanism to the specific cloud provider hosting compute,
  making a future provider migration harder. A portable `pg_dump` file that can be
  restored anywhere Postgres runs was preferred.

## Consequences

- One more required capability from the existing R2 credentials (object write access
  to a new prefix/bucket) — confirmed **not currently working** in the environment
  this ADR was written in (403 Access Denied on all R2 operations, not specific to
  backups — see [docs/DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md)). This needs to
  be resolved in the Cloudflare dashboard before offsite backups function.
- Restore requires network access to R2 (or a manually-copied local file) — a fully
  air-gapped restore path doesn't exist and isn't planned given the current scale.
