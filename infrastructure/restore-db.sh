#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# Kodspot PostgreSQL Restore Script
#
# Deliberately has no default target container and no default "yes" — a restore is
# destructive (the backup was taken with pg_dump --clean --if-exists, so restoring it
# drops and recreates objects in the target database). Every argument below is
# required precisely so this can never be run accidentally against the wrong target.
#
# Usage:
#   ./restore-db.sh --target-container <name> --file <path/to/backup.sql.gz>
#   ./restore-db.sh --target-container <name> --from-offsite [key]   # downloads
#                                                                     # from R2 first;
#                                                                     # omit key for
#                                                                     # the latest
#   Add --yes to skip the interactive confirmation prompt (for scripted drills/CI).
#
# See docs/DISASTER_RECOVERY.md for the full restore runbook and drill record.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TARGET_CONTAINER=""
BACKUP_FILE=""
FROM_OFFSITE=""
OFFSITE_KEY=""
ASSUME_YES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target-container) TARGET_CONTAINER="$2"; shift 2 ;;
    --file) BACKUP_FILE="$2"; shift 2 ;;
    --from-offsite)
      FROM_OFFSITE="1"
      # Optional key argument — only consume it if it doesn't look like another flag
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then OFFSITE_KEY="$2"; shift 2; else shift 1; fi
      ;;
    --yes) ASSUME_YES="1"; shift 1 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "${TARGET_CONTAINER}" ]; then
  echo "ERROR: --target-container <name> is required — a restore never has a default target."
  exit 1
fi

if [ -z "${BACKUP_FILE}" ] && [ -z "${FROM_OFFSITE}" ]; then
  echo "ERROR: specify either --file <path> or --from-offsite [key]"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${TARGET_CONTAINER}$"; then
  echo "ERROR: target container '${TARGET_CONTAINER}' is not running"
  exit 1
fi

# Load DB_USER/DB_NAME from .env, same convention as backup-db.sh
if [ -f "${SCRIPT_DIR}/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -E '^(DB_USER|DB_NAME)=' "${SCRIPT_DIR}/.env" | xargs)
fi
DB_USER="${DB_USER:-kodspot}"
DB_NAME="${DB_NAME:-kodspot}"

# ── Resolve the backup file, downloading from R2 first if requested ──
if [ -n "${FROM_OFFSITE}" ]; then
  BACKUP_FILE="/tmp/restore-drill-$(date +%s).sql.gz"
  if [ -n "${OFFSITE_KEY}" ]; then
    node "${SCRIPT_DIR}/apps/api/scripts/backup-r2.js" download "${OFFSITE_KEY}" "${BACKUP_FILE}"
  else
    node "${SCRIPT_DIR}/apps/api/scripts/backup-r2.js" download-latest "${BACKUP_FILE}"
  fi
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: backup file not found: ${BACKUP_FILE}"
  exit 1
fi

# ── Confirm before doing anything destructive ──
echo "─────────────────────────────────────────────"
echo "About to RESTORE (drop + recreate objects):"
echo "  Backup file:       ${BACKUP_FILE}"
echo "  Target container:  ${TARGET_CONTAINER}"
echo "  Target database:   ${DB_NAME} (user: ${DB_USER})"
echo "─────────────────────────────────────────────"
if [ -z "${ASSUME_YES}" ]; then
  read -r -p "Type 'restore' to continue: " CONFIRM
  if [ "${CONFIRM}" != "restore" ]; then
    echo "Aborted — no changes made."
    exit 1
  fi
fi

START_TS=$(date +%s)
echo "[$(date -Iseconds)] Restore starting..."

gunzip -c "${BACKUP_FILE}" | docker exec -i "${TARGET_CONTAINER}" \
  psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 --quiet

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
echo "[$(date -Iseconds)] Restore complete in ${ELAPSED}s"

# ── Basic sanity check: the restored database should have the expected tables ──
TABLE_COUNT=$(docker exec "${TARGET_CONTAINER}" \
  psql -U "${DB_USER}" -d "${DB_NAME}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "[$(date -Iseconds)] Restored database has ${TABLE_COUNT} tables in the public schema"

if [ "${TABLE_COUNT}" -lt 1 ]; then
  echo "ERROR: restored database has no tables — restore likely failed"
  exit 1
fi

echo "[$(date -Iseconds)] Restore finished successfully in ${ELAPSED}s — record this RTO in docs/DISASTER_RECOVERY.md"
