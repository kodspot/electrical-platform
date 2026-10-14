#!/bin/bash
# Tests for infrastructure/backup-db.sh — plain bash, no Docker, no network.
# A fake `docker` placed first on PATH records every call and plays the database dump and
# the in-container uploader. The script runs from an isolated temp tree (its own .env with
# canary secrets), never from the real repository.
#
# Cases: success; offsite upload failure (pruning still runs, exit non-zero, "offsite upload
# failed" logged, no secret printed); dump failure (exit non-zero, nothing uploaded).
#
#   bash infrastructure/tests/backup-db.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${HERE}/../backup-db.sh"
FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  ok   $1"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

setup() {
  T="$(mktemp -d)"
  mkdir -p "${T}/infrastructure" "${T}/bin" "${T}/backups"
  cp "${SCRIPT}" "${T}/infrastructure/backup-db.sh"
  printf 'DB_USER=kodspot\nDB_NAME=kodspot\nR2_SECRET_ACCESS_KEY=canary-r2-secret-xyz\nR2_ACCESS_KEY_ID=canary-r2-key-xyz\n' > "${T}/.env"
  # An old local archive (20 days) that pruning must delete, and a recent one it must keep.
  echo old > "${T}/backups/kodspot_20200101_020000.sql.gz"; touch -d '20 days ago' "${T}/backups/kodspot_20200101_020000.sql.gz"
  echo recent > "${T}/backups/kodspot_20990101_020000.sql.gz"
  cat > "${T}/bin/docker" <<'FAKE'
#!/bin/bash
echo "docker $* | cwd=$(pwd)" >> "${FAKE_LOG}"
case "$1" in
  ps) echo electrical-api; echo electrical-db ;;
  exec)
    [ "${FAKE_DUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: connection failed" >&2; exit 1; }
    for i in $(seq 1 200); do echo "INSERT INTO t VALUES ($i, 'row $i padding padding padding');"; done ;;
  compose)
    case "$*" in
      *"backup-r2.js upload - "*)
        BYTES=$(wc -c | tr -d ' ')
        echo "upload-bytes=${BYTES}" >> "${FAKE_LOG}"
        [ "${FAKE_UPLOAD_FAIL:-0}" = 1 ] && { echo "backup-r2.js failed: Access Denied" >&2; exit 1; }
        echo "Uploaded stdin (${BYTES} bytes)" ;;
      *"backup-r2.js prune "*) echo "Pruned 0 offsite backup(s)" ;;
      *) echo "unexpected compose call" >&2; exit 2 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
FAKE
  chmod +x "${T}/bin/docker" "${T}/infrastructure/backup-db.sh"
  export FAKE_LOG="${T}/docker.log"
  : > "${FAKE_LOG}"
}

run() {
  (cd / && PATH="${T}/bin:${PATH}" BACKUP_DIR="${T}/backups" bash "${T}/infrastructure/backup-db.sh") > "${T}/out.log" 2>&1
  echo $?
}

echo "backup-db.sh: success"
setup
CODE=$(FAKE_DUMP_FAIL=0 FAKE_UPLOAD_FAIL=0 run)
NEW=$(ls "${T}/backups" | grep -v -e 20200101 -e 20990101 | head -1)
check "exits 0" '[ "$CODE" = 0 ]'
check "uploads the new archive through the app container, by stdin, with its exact size" \
  'grep -q "docker compose exec -T api node scripts/backup-r2.js upload - ${NEW} | cwd=${T}$" "$FAKE_LOG" && grep -q "upload-bytes=$(wc -c < "${T}/backups/${NEW}" | tr -d " ")" "$FAKE_LOG"'
check "runs the offsite prune inside the app container" 'grep -q "backup-r2.js prune 14 | cwd=${T}$" "$FAKE_LOG"'
check "prunes local archives older than 14 days and keeps recent ones" '[ ! -e "${T}/backups/kodspot_20200101_020000.sql.gz" ] && [ -e "${T}/backups/kodspot_20990101_020000.sql.gz" ]'
check "never calls host node" '! grep -qE "(^|[^-])node .*backup-r2" "${T}/out.log"'
check "reports success" 'grep -q "Backup job finished successfully" "${T}/out.log"'
check "prints no secret" '! grep -q canary "${T}/out.log"'
rm -rf "${T}"

echo "backup-db.sh: offsite upload fails"
setup
CODE=$(FAKE_UPLOAD_FAIL=1 run)
NEW=$(ls "${T}/backups" | grep -v -e 20200101 -e 20990101 | head -1)
check "exits non-zero" '[ "$CODE" != 0 ]'
check "logs \"offsite upload failed\"" 'grep -q "offsite upload failed" "${T}/out.log"'
check "keeps the local archive" '[ -n "$NEW" ] && [ -s "${T}/backups/${NEW}" ]'
check "still prunes local archives" '[ ! -e "${T}/backups/kodspot_20200101_020000.sql.gz" ]'
check "still runs the offsite prune" 'grep -q "backup-r2.js prune 14" "$FAKE_LOG"'
check "does not claim success" '! grep -q "finished successfully" "${T}/out.log"'
check "prints no secret" '! grep -q canary "${T}/out.log"'
rm -rf "${T}"

echo "backup-db.sh: dump fails"
setup
CODE=$(FAKE_DUMP_FAIL=1 run)
check "exits non-zero" '[ "$CODE" != 0 ]'
check "uploads nothing and prunes nothing offsite" '! grep -q "backup-r2.js" "$FAKE_LOG"'
check "leaves no partial archive" '[ "$(ls "${T}/backups" | grep -vc -e 20200101 -e 20990101)" = 0 ]'
check "logs the dump failure" 'grep -q "pg_dump failed" "${T}/out.log"'
rm -rf "${T}"

echo "backup-db.sh tests: ${PASSES} passed, ${FAILS} failed"
[ "${FAILS}" -eq 0 ]
