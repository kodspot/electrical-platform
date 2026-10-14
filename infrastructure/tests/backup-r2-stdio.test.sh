#!/bin/bash
# Tests for the stdin/stdout modes of apps/api/scripts/backup-r2.js, which
# infrastructure/backup-db.sh and restore-db.sh use from inside the app container.
# No network: a --require preload replaces @aws-sdk/client-s3 with a stub that records
# commands. The script runs from a temp copy, so no real .env is read.
# Needs node and apps/api/node_modules (for dotenv), as after `npm ci` in apps/api.
#
#   bash infrastructure/tests/backup-r2-stdio.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
FAILS=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  ok   $1"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL $1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT
mkdir -p "${T}/apps/api/scripts"
cp "${REPO}/apps/api/scripts/backup-r2.js" "${T}/apps/api/scripts/backup-r2.js"
export NODE_PATH="${REPO}/apps/api/node_modules"
export STUB_LOG="${T}/s3.log"
: > "${STUB_LOG}"

cat > "${T}/stub-s3.js" <<'STUB'
// Replaces @aws-sdk/client-s3 for backup-r2.js: records each command, serves fixed objects.
const Module = require('module');
const fs = require('fs');
const log = (o) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + '\n');
class Cmd { constructor(input) { this.input = input; } }
const make = (name) => class extends Cmd { get name() { return name; } };
const stub = {
  PutObjectCommand: make('Put'), GetObjectCommand: make('Get'),
  ListObjectsV2Command: make('List'), DeleteObjectCommand: make('Delete'),
  S3Client: class {
    async send(cmd) {
      const i = cmd.input;
      if (cmd.name === 'Put') { log({ cmd: 'Put', key: i.Key, bytes: i.Body.length, sha: require('crypto').createHash('sha256').update(i.Body).digest('hex') }); return {}; }
      if (cmd.name === 'Get') { log({ cmd: 'Get', key: i.Key }); const body = Buffer.from(`ARCHIVE:${i.Key}`); return { Body: (async function* () { yield body; })() }; }
      if (cmd.name === 'List') return { Contents: [
        { Key: 'db-backups/kodspot_20261012_020000.sql.gz', Size: 1, LastModified: new Date('2026-10-12T02:00:00Z') },
        { Key: 'db-backups/kodspot_20261013_020000.sql.gz', Size: 1, LastModified: new Date('2026-10-13T02:00:00Z') }
      ] };
      return {};
    }
  }
};
const orig = Module._load;
Module._load = function (request, ...rest) { return request === '@aws-sdk/client-s3' ? stub : orig.call(this, request, ...rest); };
STUB

r2() {
  R2_ACCOUNT_ID=test R2_ACCESS_KEY_ID=test-key R2_SECRET_ACCESS_KEY=canary-secret R2_BUCKET_NAME=test-bucket \
    node --require "${T}/stub-s3.js" "${T}/apps/api/scripts/backup-r2.js" "$@"
}

echo "backup-r2.js: upload - <name> (stdin)"
head -c 5000 /dev/urandom > "${T}/archive.gz"
WANT=$( (sha256sum "${T}/archive.gz" 2>/dev/null || shasum -a 256 "${T}/archive.gz") | cut -d' ' -f1)
r2 upload - kodspot_20261014_020000.sql.gz < "${T}/archive.gz" > "${T}/out" 2>&1; CODE=$?
check "exits 0" '[ "$CODE" = 0 ]'
check "puts the exact stdin bytes under db-backups/<name>" 'grep -q "\"key\":\"db-backups/kodspot_20261014_020000.sql.gz\",\"bytes\":5000,\"sha\":\"${WANT}\"" "$STUB_LOG"'
check "prints no secret" '! grep -q canary "${T}/out"'

: > "${STUB_LOG}"
r2 upload - ../../etc/passwd < "${T}/archive.gz" > "${T}/out" 2>&1; CODE=$?
check "rejects a name that is not a backup archive name, without uploading" '[ "$CODE" != 0 ] && [ ! -s "$STUB_LOG" ]'
r2 upload - kodspot_20261014_020000.sql.gz < /dev/null > "${T}/out" 2>&1; CODE=$?
check "rejects empty stdin, without uploading" '[ "$CODE" != 0 ] && [ ! -s "$STUB_LOG" ]'

echo "backup-r2.js: download <key> - and download-latest - (stdout)"
r2 download db-backups/kodspot_20261012_020000.sql.gz - > "${T}/dl" 2> "${T}/err"; CODE=$?
check "exits 0" '[ "$CODE" = 0 ]'
check "stdout carries only the archive bytes" '[ "$(cat "${T}/dl")" = "ARCHIVE:db-backups/kodspot_20261012_020000.sql.gz" ]'
check "the log line goes to stderr" 'grep -q "Downloaded .* -> stdout" "${T}/err"'
r2 download-latest - > "${T}/dl" 2> "${T}/err"; CODE=$?
check "download-latest streams the newest archive" '[ "$CODE" = 0 ] && [ "$(cat "${T}/dl")" = "ARCHIVE:db-backups/kodspot_20261013_020000.sql.gz" ]'

echo "backup-r2.js stdio tests: ${PASSES} passed, ${FAILS} failed"
[ "${FAILS}" -eq 0 ]
