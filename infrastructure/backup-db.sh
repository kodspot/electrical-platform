#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# Kodspot PostgreSQL Automated Backup Script
#
# Usage:
#   ./backup-db.sh                  # Manual run
#   Add to crontab for automated daily backups:
#     0 2 * * * /path/to/backup-db.sh >> /var/log/kodspot-backup.log 2>&1
#
# Retention: keeps the last 14 daily backups locally (configurable below), and the
# last 14 days of offsite copies in Cloudflare R2 (see docs/DISASTER_RECOVERY.md) —
# a local-only backup does not survive the loss of the host it protects.
#
# The host has no Node.js. The offsite steps run apps/api/scripts/backup-r2.js inside
# the app container (`docker compose exec -T api node scripts/backup-r2.js ...`), which
# already has the R2 credentials from .env. The archive is streamed through stdin, so
# the container never needs access to the host's backup directory.
#
# Exit status: non-zero if the dump fails (nothing is uploaded or pruned), or if the
# offsite upload fails. In that case local and offsite pruning still run first, and the
# local archive is kept.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ──
CONTAINER_NAME="electrical-db"
BACKUP_DIR="${BACKUP_DIR:-/opt/kodspot-backups}"
RETENTION_DAYS=14
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="kodspot_${TIMESTAMP}.sql.gz"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_NAME}"

# Repository root: docker compose runs from here (docker-compose.yml + .env).
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load DB_USER/DB_NAME from the project .env (the R2 credentials stay inside the container).
if [ -f "${SCRIPT_DIR}/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(DB_USER|DB_NAME)=' "${SCRIPT_DIR}/.env" | xargs)
fi

DB_USER="${DB_USER:-kodspot}"
DB_NAME="${DB_NAME:-kodspot}"

# Run backup-r2.js inside the app container.
backup_r2() {
  (cd "${SCRIPT_DIR}" && docker compose exec -T api node scripts/backup-r2.js "$@")
}

# ── Preflight checks ──
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "[$(date -Iseconds)] ERROR: Container '${CONTAINER_NAME}' is not running"
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# ── Create backup ──
echo "[$(date -Iseconds)] Starting backup: ${BACKUP_FILE}"

if ! docker exec "${CONTAINER_NAME}" \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" \
    --no-owner --no-privileges --clean --if-exists \
    --format=plain \
  | gzip -9 > "${BACKUP_FILE}"; then
  echo "[$(date -Iseconds)] ERROR: pg_dump failed — nothing uploaded or pruned"
  rm -f "${BACKUP_FILE}"
  exit 1
fi

BACKUP_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "[$(date -Iseconds)] Backup complete: ${BACKUP_FILE} (${BACKUP_SIZE})"

# ── Verify backup is not empty ──
MIN_SIZE=1024 # 1KB minimum — a valid dump is always larger
FILE_SIZE=$(stat -c%s "${BACKUP_FILE}" 2>/dev/null || stat -f%z "${BACKUP_FILE}" 2>/dev/null)
if [ "${FILE_SIZE}" -lt "${MIN_SIZE}" ]; then
  echo "[$(date -Iseconds)] ERROR: Backup file too small (${FILE_SIZE} bytes) — possible failure"
  rm -f "${BACKUP_FILE}"
  exit 1
fi

# ── Upload offsite (Cloudflare R2) — a local-only backup does not survive losing
#    this host, which is the exact scenario a backup exists to protect against ──
echo "[$(date -Iseconds)] Uploading backup offsite..."
UPLOAD_FAILED=0
if backup_r2 upload - "${BACKUP_NAME}" < "${BACKUP_FILE}"; then
  echo "[$(date -Iseconds)] Offsite upload complete"
else
  UPLOAD_FAILED=1
  echo "[$(date -Iseconds)] ERROR: offsite upload failed — the local copy is kept at ${BACKUP_FILE}"
fi

# ── Prune old local backups (runs even if the upload failed) ──
DELETED=$(find "${BACKUP_DIR}" -name "kodspot_*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
if [ "${DELETED}" -gt 0 ]; then
  echo "[$(date -Iseconds)] Pruned ${DELETED} local backup(s) older than ${RETENTION_DAYS} days"
fi

# ── Prune old offsite backups (same retention window; runs even if the upload failed) ──
if ! backup_r2 prune "${RETENTION_DAYS}"; then
  echo "[$(date -Iseconds)] WARNING: offsite prune failed"
fi

if [ "${UPLOAD_FAILED}" -ne 0 ]; then
  echo "[$(date -Iseconds)] Backup job finished WITH ERRORS: offsite upload failed"
  exit 1
fi

echo "[$(date -Iseconds)] Backup job finished successfully"
