#!/usr/bin/env bash

# Creates encrypted database, storage, and verification-manifest artifacts.
# Run acknowledged only after primary and replica copies match. Offsite upload
# can be mandatory in production with REQUIRE_OFFSITE_BACKUP=true.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
PRIMARY_DIR="${BACKUP_PRIMARY_DIR:-${BACKUP_DIR}/primary}"
REPLICA_DIR="${BACKUP_REPLICA_DIR:-/backups-replica}"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_ID="${BACKUP_ID:-${TIMESTAMP}}"
WORK_DIR="$(mktemp -d /tmp/docvault-backup.XXXXXX)"
CURRENT_STAGE="created"
PASSPHRASE_FILE="${WORK_DIR}/gpg-passphrase"

# shellcheck source=status-lib.sh
source "${SCRIPT_DIR}/status-lib.sh"

log() {
  echo "[run-backup] $(status_now) - $*"
}

cleanup() {
  rm -rf "${WORK_DIR}"
}

on_error() {
  local exit_code=$?
  trap - ERR
  local message="Backup failed during ${CURRENT_STAGE}; inspect backup service logs"
  log "ERROR: ${message}"
  if [ -f "${STATUS_FILE}" ]; then
    status_set_stage "${CURRENT_STAGE}" failed "${message}" || true
    status_mark_failure "${message}" || true
    "${SCRIPT_DIR}/notify-failure.sh" "DocVault backup failed" "${message}" || true
  fi
  exit "${exit_code}"
}
trap cleanup EXIT
trap on_error ERR

mkdir -p "${PRIMARY_DIR}"
status_init "${BACKUP_ID}"

if [[ ! "${BACKUP_ID}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: BACKUP_ID may contain only letters, numbers, underscore, and hyphen" >&2
  false
fi

for required in DATABASE_URL STORAGE_PATH BACKUP_ENCRYPTION_KEY; do
  if [ -z "${!required:-}" ]; then
    echo "ERROR: ${required} is not set" >&2
    false
  fi
done
if [ "${PRIMARY_DIR}" = "${REPLICA_DIR}" ]; then
  echo "ERROR: backup primary and replica directories must differ" >&2
  false
fi

mkdir -p "${REPLICA_DIR}"
printf '%s' "${BACKUP_ENCRYPTION_KEY}" > "${PASSPHRASE_FILE}"
chmod 600 "${PASSPHRASE_FILE}"

DB_FILE="db-${BACKUP_ID}.sql.gz"
STORAGE_FILE="storage-${BACKUP_ID}.tar.gz"
MANIFEST_FILE="manifest-${BACKUP_ID}.json"

log "Creating database dump, storage archive, and restore manifest."
pg_dump "${DATABASE_URL}" | gzip > "${WORK_DIR}/${DB_FILE}"
tar -czf "${WORK_DIR}/${STORAGE_FILE}" -C "$(dirname "${STORAGE_PATH}")" "$(basename "${STORAGE_PATH}")"

DB_SHA256="$(sha256sum "${WORK_DIR}/${DB_FILE}" | awk '{print $1}')"
STORAGE_SHA256="$(sha256sum "${WORK_DIR}/${STORAGE_FILE}" | awk '{print $1}')"
SAMPLES_FILE="${WORK_DIR}/samples.json"
printf '[]\n' > "${SAMPLES_FILE}"

sample_count=0
while IFS= read -r -d '' original; do
  relative_path="${original#"${STORAGE_PATH}"/}"
  original_sha256="$(sha256sum "${original}" | awk '{print $1}')"
  jq --arg path "${relative_path}" --arg sha256 "${original_sha256}" \
    '. + [{path: $path, sha256: $sha256}]' "${SAMPLES_FILE}" > "${SAMPLES_FILE}.tmp"
  mv "${SAMPLES_FILE}.tmp" "${SAMPLES_FILE}"
  sample_count=$((sample_count + 1))
  if [ "${sample_count}" -ge "${RESTORE_SAMPLE_SIZE:-25}" ]; then
    break
  fi
done < <(find "${STORAGE_PATH}/originals" -type f -print0 2>/dev/null | sort -z)

jq -n \
  --arg backup_id "${BACKUP_ID}" \
  --arg created_at "$(status_now)" \
  --arg db_file "${DB_FILE}" \
  --arg db_sha256 "${DB_SHA256}" \
  --arg storage_file "${STORAGE_FILE}" \
  --arg storage_sha256 "${STORAGE_SHA256}" \
  --slurpfile samples "${SAMPLES_FILE}" \
  '{version: 1, backupId: $backup_id, createdAt: $created_at, database: {file: $db_file, sha256: $db_sha256}, storage: {file: $storage_file, sha256: $storage_sha256}, sampledOriginals: $samples[0]}' \
  > "${WORK_DIR}/${MANIFEST_FILE}"

for artifact in "${DB_FILE}" "${STORAGE_FILE}" "${MANIFEST_FILE}"; do
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "${PASSPHRASE_FILE}" \
    --cipher-algo AES256 --symmetric --output "${PRIMARY_DIR}/${artifact}.gpg" "${WORK_DIR}/${artifact}"
done

db_size="$(stat -c%s "${PRIMARY_DIR}/${DB_FILE}.gpg")"
storage_size="$(stat -c%s "${PRIMARY_DIR}/${STORAGE_FILE}.gpg")"
status_set_sizes "${db_size}" "${storage_size}"
status_set_stage created succeeded "Encrypted artifacts created"

CURRENT_STAGE="replicated"
log "Copying encrypted artifacts to independent local replica."
for artifact in "${DB_FILE}.gpg" "${STORAGE_FILE}.gpg" "${MANIFEST_FILE}.gpg"; do
  cp "${PRIMARY_DIR}/${artifact}" "${REPLICA_DIR}/${artifact}"
  primary_hash="$(sha256sum "${PRIMARY_DIR}/${artifact}" | awk '{print $1}')"
  replica_hash="$(sha256sum "${REPLICA_DIR}/${artifact}" | awk '{print $1}')"
  [ "${primary_hash}" = "${replica_hash}" ]
done
status_set_stage replicated succeeded "Replica hashes match"

CURRENT_STAGE="uploaded"
if [ -n "${RCLONE_REMOTE:-}" ]; then
  log "Uploading encrypted artifacts offsite."
  for artifact in "${DB_FILE}.gpg" "${STORAGE_FILE}.gpg" "${MANIFEST_FILE}.gpg"; do
    rclone copyto "${PRIMARY_DIR}/${artifact}" "${RCLONE_REMOTE%/}/${artifact}"
  done
  rclone check "${PRIMARY_DIR}" "${RCLONE_REMOTE}" --one-way \
    --include "*-${BACKUP_ID}.*.gpg" --include "manifest-${BACKUP_ID}.json.gpg"
  status_set_stage uploaded succeeded "Encrypted artifacts verified offsite"
else
  if [ "${REQUIRE_OFFSITE_BACKUP:-false}" = "true" ]; then
    echo "RCLONE_REMOTE is required when REQUIRE_OFFSITE_BACKUP=true" >&2
    false
  fi
  status_set_stage uploaded skipped "Offsite remote not configured"
fi

CURRENT_STAGE="retained"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
if [[ ! "${retention_days}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  false
fi
find "${PRIMARY_DIR}" -type f -name '*.gpg' -mtime "+${retention_days}" -delete
find "${REPLICA_DIR}" -type f -name '*.gpg' -mtime "+${retention_days}" -delete
if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone delete "${RCLONE_REMOTE}" --min-age "${retention_days}d" --include '*.gpg'
fi
status_set_stage retained succeeded "Artifacts older than ${retention_days} days removed"

status_mark_backup_complete
log "Backup ${BACKUP_ID} created, replicated, and retained successfully."
