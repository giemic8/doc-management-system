#!/usr/bin/env bash
#
# verify-restore.sh — "1-Click Restore verification" (Ticket #17).
#
# Downloads the most recent backup artifacts from the offsite rclone remote,
# decrypts them, and integrity-checks them WITHOUT actually restoring into a
# live database (that would require a throwaway DB instance and is out of
# scope here — destructive/live restores are intentionally not automated).
#
# Verification performed:
#   - DB dump (*.gpg): decrypts cleanly -> gunzip -t passes (valid gzip) ->
#     decompressed content starts with the expected `pg_dump` header comment.
#   - Storage archive (*.gpg): decrypts cleanly -> tar -tzf lists its contents
#     without error (valid gzip+tar).
#
# Required env vars:
#   BACKUP_ENCRYPTION_KEY   GPG symmetric passphrase used to decrypt
#   RCLONE_REMOTE           rclone remote path to pull the latest backups from
#
# Exits 0 on PASS, 1 on FAIL. Always cleans up its temp directory.

set -euo pipefail

WORK_DIR="$(mktemp -d /tmp/dms-restore-verify.XXXXXX)"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

log() {
  echo "[verify-restore] $(date -u +'%Y-%m-%dT%H:%M:%SZ') - $*"
}

FAILURES=0

fail() {
  log "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: BACKUP_ENCRYPTION_KEY is not set" >&2
  exit 1
fi
if [ -z "${RCLONE_REMOTE:-}" ]; then
  echo "ERROR: RCLONE_REMOTE is not set" >&2
  exit 1
fi

log "Fetching latest backup artifacts from ${RCLONE_REMOTE} into ${WORK_DIR}..."
# --max-age keeps this to recently-produced files so we verify "the latest
# backup" rather than downloading the entire offsite history.
rclone copy "${RCLONE_REMOTE}" "${WORK_DIR}" --max-age 48h || {
  echo "ERROR: rclone copy from offsite remote failed" >&2
  exit 1
}

LATEST_DB_GPG=$(ls -t "${WORK_DIR}"/db-*.sql.gz.gpg 2>/dev/null | head -n1 || true)
LATEST_STORAGE_GPG=$(ls -t "${WORK_DIR}"/storage-*.tar.gz.gpg 2>/dev/null | head -n1 || true)

if [ -z "${LATEST_DB_GPG}" ]; then
  fail "No database backup (db-*.sql.gz.gpg) found offsite within the last 48h."
else
  log "Verifying database backup: ${LATEST_DB_GPG}"
  DECRYPTED_DB="${WORK_DIR}/db-decrypted.sql.gz"

  if gpg --batch --yes --passphrase "${BACKUP_ENCRYPTION_KEY}" --decrypt \
      --output "${DECRYPTED_DB}" "${LATEST_DB_GPG}" 2>"${WORK_DIR}/gpg-db.log"; then
    log "  - GPG decryption OK"

    if gunzip -t "${DECRYPTED_DB}" 2>"${WORK_DIR}/gunzip-db.log"; then
      log "  - gzip integrity OK"

      HEADER="$(gunzip -c "${DECRYPTED_DB}" | head -n5)"
      if echo "${HEADER}" | grep -q -- '-- PostgreSQL database dump'; then
        log "  - pg_dump header check OK"
      else
        fail "Decompressed DB dump does not start with the expected pg_dump header."
      fi
    else
      fail "gunzip integrity check failed for decrypted DB dump (see gunzip-db.log)."
    fi
  else
    fail "GPG decryption failed for database backup (see gpg-db.log)."
  fi
fi

if [ -z "${LATEST_STORAGE_GPG}" ]; then
  fail "No storage backup (storage-*.tar.gz.gpg) found offsite within the last 48h."
else
  log "Verifying storage archive backup: ${LATEST_STORAGE_GPG}"
  DECRYPTED_STORAGE="${WORK_DIR}/storage-decrypted.tar.gz"

  if gpg --batch --yes --passphrase "${BACKUP_ENCRYPTION_KEY}" --decrypt \
      --output "${DECRYPTED_STORAGE}" "${LATEST_STORAGE_GPG}" 2>"${WORK_DIR}/gpg-storage.log"; then
    log "  - GPG decryption OK"

    if tar -tzf "${DECRYPTED_STORAGE}" >"${WORK_DIR}/tar-list.log" 2>&1; then
      log "  - tar+gzip integrity OK ($(wc -l < "${WORK_DIR}/tar-list.log" | tr -d ' ') entries)"
    else
      fail "tar listing failed for decrypted storage archive (see tar-list.log)."
    fi
  else
    fail "GPG decryption failed for storage archive (see gpg-storage.log)."
  fi
fi

echo ""
if [ "${FAILURES}" -eq 0 ]; then
  echo "==== RESTORE VERIFICATION: PASS ===="
  echo "Both the database dump and storage archive decrypted cleanly and passed"
  echo "integrity checks. Note: this validates the backup ARTIFACTS only — it"
  echo "does not perform a live restore into a database (out of scope)."
  exit 0
else
  echo "==== RESTORE VERIFICATION: FAIL (${FAILURES} check(s) failed) ===="
  exit 1
fi
