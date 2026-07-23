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
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ──
CONTAINER_NAME="electrical-db"
BACKUP_DIR="${BACKUP_DIR:-/opt/kodspot-backups}"
RETENTION_DAYS=14
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/kodspot_${TIMESTAMP}.sql.gz"

# Load env vars (DB_USER, DB_NAME, and R2_* for offsite upload) from project .env
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "${SCRIPT_DIR}/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(DB_USER|DB_NAME|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET_NAME|R2_BACKUP_BUCKET_NAME)=' "${SCRIPT_DIR}/.env" | xargs)
fi

DB_USER="${DB_USER:-kodspot}"
DB_NAME="${DB_NAME:-kodspot}"

# ── Preflight checks ──
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "[$(date -Iseconds)] ERROR: Container '${CONTAINER_NAME}' is not running"
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# ── Create backup ──
echo "[$(date -Iseconds)] Starting backup: ${BACKUP_FILE}"

docker exec "${CONTAINER_NAME}" \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" \
    --no-owner --no-privileges --clean --if-exists \
    --format=plain \
  | gzip -9 > "${BACKUP_FILE}"

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
node "${SCRIPT_DIR}/apps/api/scripts/backup-r2.js" upload "${BACKUP_FILE}"
echo "[$(date -Iseconds)] Offsite upload complete"

# ── Prune old local backups ──
DELETED=$(find "${BACKUP_DIR}" -name "kodspot_*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
if [ "${DELETED}" -gt 0 ]; then
  echo "[$(date -Iseconds)] Pruned ${DELETED} local backup(s) older than ${RETENTION_DAYS} days"
fi

# ── Prune old offsite backups (same retention window) ──
node "${SCRIPT_DIR}/apps/api/scripts/backup-r2.js" prune "${RETENTION_DAYS}"

echo "[$(date -Iseconds)] Backup job finished successfully"
