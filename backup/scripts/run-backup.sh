#!/usr/bin/env bash
#
# run-backup.sh — Daily encrypted offsite backup job (Ticket #17).
#
# What it does, step by step:
#   1. pg_dump the app database, piped through gzip -> db-<ts>.sql.gz
#   2. tar+gzip the document originals directory ($STORAGE_PATH) -> storage-<ts>.tar.gz
#   3. GPG-symmetric-encrypt (AES-256) both artifacts -> *.gpg, then delete the
#      unencrypted intermediates so nothing plaintext-sensitive lingers on disk.
#   4. rclone copy the *.gpg files to the configured offsite remote. rclone
#      itself is provider-agnostic (S3, Wasabi, Hetzner Storage Box, MinIO, ...);
#      the actual provider + credentials live in a mounted rclone.conf (see
#      backup/rclone.conf.example), NOT in this script or in env vars we control.
#   5. Write /backups/last-backup-status.json with a summary the backend API
#      (GET /api/backup/status) reads to power the admin dashboard.
#
# Required env vars:
#   DATABASE_URL            postgres connection string consumed by pg_dump
#   STORAGE_PATH            directory containing document originals to archive
#   BACKUP_ENCRYPTION_KEY   GPG symmetric passphrase (AES-256)
#   RCLONE_REMOTE           rclone remote path, e.g. "myS3remote:docvault-backups/"
#                           (leave empty to skip the offsite upload step, useful
#                           for local dev/testing without real cloud credentials)
#
# Exits non-zero on any failure so `docker logs` / orchestration can alert.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATUS_FILE="${BACKUP_DIR}/last-backup-status.json"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

DB_DUMP_FILE="${BACKUP_DIR}/db-${TIMESTAMP}.sql.gz"
STORAGE_ARCHIVE_FILE="${BACKUP_DIR}/storage-${TIMESTAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

log() {
  echo "[run-backup] $(date -u +'%Y-%m-%dT%H:%M:%SZ') - $*"
}

# Writes the JSON status file read by the backend's /api/backup/status route.
# Called both on success and (via the ERR trap below) on failure.
write_status() {
  local success="$1"
  local error_message="${2:-}"
  local db_size=0
  local storage_size=0

  if [ -f "${DB_DUMP_FILE}.gpg" ]; then
    db_size=$(stat -c%s "${DB_DUMP_FILE}.gpg" 2>/dev/null || stat -f%z "${DB_DUMP_FILE}.gpg" 2>/dev/null || echo 0)
  fi
  if [ -f "${STORAGE_ARCHIVE_FILE}.gpg" ]; then
    storage_size=$(stat -c%s "${STORAGE_ARCHIVE_FILE}.gpg" 2>/dev/null || stat -f%z "${STORAGE_ARCHIVE_FILE}.gpg" 2>/dev/null || echo 0)
  fi

  # Minimal hand-rolled JSON (no jq dependency) — fields match backend's
  # BackupStatus shape in backend/src/services/backupStatus.service.ts.
  if [ -n "${error_message}" ]; then
    cat > "${STATUS_FILE}" <<EOF
{
  "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "dbBackupSizeBytes": ${db_size},
  "storageBackupSizeBytes": ${storage_size},
  "success": ${success},
  "error": "$(echo "${error_message}" | sed 's/"/\\"/g')"
}
EOF
  else
    cat > "${STATUS_FILE}" <<EOF
{
  "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "dbBackupSizeBytes": ${db_size},
  "storageBackupSizeBytes": ${storage_size},
  "success": ${success}
}
EOF
  fi
}

on_error() {
  local exit_code=$?
  log "ERROR: backup failed with exit code ${exit_code}"
  write_status "false" "Backup failed with exit code ${exit_code}. See container logs for details."
  # Best-effort cleanup of any half-written intermediates.
  rm -f "${DB_DUMP_FILE}" "${STORAGE_ARCHIVE_FILE}" 2>/dev/null || true
  exit "${exit_code}"
}
trap on_error ERR

if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL is not set"
  exit 1
fi
if [ -z "${STORAGE_PATH:-}" ]; then
  log "ERROR: STORAGE_PATH is not set"
  exit 1
fi
if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  log "ERROR: BACKUP_ENCRYPTION_KEY is not set"
  exit 1
fi

log "Starting backup run ${TIMESTAMP}"

# --- Step 1: Database dump ---------------------------------------------
log "Dumping PostgreSQL database via pg_dump..."
pg_dump "${DATABASE_URL}" | gzip > "${DB_DUMP_FILE}"
log "Database dump written to ${DB_DUMP_FILE}"

# --- Step 2: Storage archive ---------------------------------------------
log "Archiving document storage directory (${STORAGE_PATH})..."
if [ -d "${STORAGE_PATH}" ]; then
  tar -czf "${STORAGE_ARCHIVE_FILE}" -C "$(dirname "${STORAGE_PATH}")" "$(basename "${STORAGE_PATH}")"
  log "Storage archive written to ${STORAGE_ARCHIVE_FILE}"
else
  log "WARNING: STORAGE_PATH (${STORAGE_PATH}) does not exist, creating empty placeholder archive"
  tar -czf "${STORAGE_ARCHIVE_FILE}" --files-from=/dev/null
fi

# --- Step 3: Encrypt both artifacts with GPG symmetric AES-256 -----------
log "Encrypting database dump with GPG (AES-256)..."
gpg --batch --yes --passphrase "${BACKUP_ENCRYPTION_KEY}" --cipher-algo AES256 --symmetric \
  --output "${DB_DUMP_FILE}.gpg" "${DB_DUMP_FILE}"
rm -f "${DB_DUMP_FILE}"

log "Encrypting storage archive with GPG (AES-256)..."
gpg --batch --yes --passphrase "${BACKUP_ENCRYPTION_KEY}" --cipher-algo AES256 --symmetric \
  --output "${STORAGE_ARCHIVE_FILE}.gpg" "${STORAGE_ARCHIVE_FILE}"
rm -f "${STORAGE_ARCHIVE_FILE}"

log "Encrypted artifacts: ${DB_DUMP_FILE}.gpg, ${STORAGE_ARCHIVE_FILE}.gpg"

# --- Step 4: Offsite sync via rclone --------------------------------------
if [ -n "${RCLONE_REMOTE:-}" ]; then
  log "Uploading encrypted artifacts offsite via rclone to ${RCLONE_REMOTE}..."
  rclone copy "${DB_DUMP_FILE}.gpg" "${RCLONE_REMOTE}"
  rclone copy "${STORAGE_ARCHIVE_FILE}.gpg" "${RCLONE_REMOTE}"
  log "Offsite upload complete."
else
  log "RCLONE_REMOTE not configured — skipping offsite upload (artifacts remain in ${BACKUP_DIR} only)."
fi

# --- Step 5: Write success status -----------------------------------------
write_status "true"
log "Backup run ${TIMESTAMP} completed successfully."
