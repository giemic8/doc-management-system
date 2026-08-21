#!/usr/bin/env bash

# Restores latest backup into disposable database and temporary storage tree.
# Never targets live database: restore name is constrained and source/target
# URLs must differ. Sampled original hashes come from encrypted manifest.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
PRIMARY_DIR="${BACKUP_PRIMARY_DIR:-${BACKUP_DIR}/primary}"
WORK_DIR="$(mktemp -d /tmp/docvault-restore.XXXXXX)"
CURRENT_STAGE="decrypted"
RESTORE_DB_CREATED=false
PASSPHRASE_FILE="${WORK_DIR}/gpg-passphrase"

# shellcheck source=status-lib.sh
source "${SCRIPT_DIR}/status-lib.sh"

log() {
  echo "[verify-restore] $(status_now) - $*"
}

cleanup() {
  if [ "${RESTORE_DB_CREATED}" = "true" ] && [ "${KEEP_RESTORE_DATABASE:-false}" != "true" ]; then
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${RESTORE_DATABASE_NAME}\" WITH (FORCE);" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
}

on_error() {
  local exit_code=$?
  trap - ERR
  local message="Restore verification failed during ${CURRENT_STAGE}; inspect backup service logs"
  log "ERROR: ${message}"
  status_set_stage "${CURRENT_STAGE}" failed "${message}" || true
  status_mark_failure "${message}" || true
  "${SCRIPT_DIR}/notify-failure.sh" "DocVault restore drill failed" "${message}" || true
  exit "${exit_code}"
}
trap cleanup EXIT
trap on_error ERR

for required in DATABASE_URL RESTORE_DATABASE_URL RESTORE_DATABASE_NAME BACKUP_ENCRYPTION_KEY STORAGE_PATH; do
  if [ -z "${!required:-}" ]; then
    echo "ERROR: ${required} is not set" >&2
    false
  fi
done
if [ "${DATABASE_URL}" = "${RESTORE_DATABASE_URL}" ]; then
  echo "ERROR: restore database URL must differ from live DATABASE_URL" >&2
  false
fi
if [[ ! "${RESTORE_DATABASE_NAME}" =~ ^dms_restore_verify(_[A-Za-z0-9]+)?$ ]]; then
  echo "ERROR: RESTORE_DATABASE_NAME must use dms_restore_verify prefix" >&2
  false
fi
restore_url_database="${RESTORE_DATABASE_URL%%\?*}"
restore_url_database="${restore_url_database##*/}"
if [ "${restore_url_database}" != "${RESTORE_DATABASE_NAME}" ]; then
  echo "ERROR: RESTORE_DATABASE_URL database must match RESTORE_DATABASE_NAME" >&2
  false
fi
printf '%s' "${BACKUP_ENCRYPTION_KEY}" > "${PASSPHRASE_FILE}"
chmod 600 "${PASSPHRASE_FILE}"

SOURCE_DIR="${WORK_DIR}/source"
mkdir -p "${SOURCE_DIR}"
if [ -n "${RCLONE_REMOTE:-}" ]; then
  log "Downloading recent encrypted artifacts from offsite storage."
  rclone copy "${RCLONE_REMOTE}" "${SOURCE_DIR}" --max-age "${RESTORE_MAX_AGE:-48h}"
else
  log "Offsite storage not configured; verifying primary local backup."
  cp "${PRIMARY_DIR}"/*.gpg "${SOURCE_DIR}/"
fi

LATEST_MANIFEST="$(find "${SOURCE_DIR}" -maxdepth 1 -type f -name 'manifest-*.json.gpg' -print | sort | tail -n1)"
[ -n "${LATEST_MANIFEST}" ]
BACKUP_ID="$(basename "${LATEST_MANIFEST}" | sed -E 's/^manifest-(.*)\.json\.gpg$/\1/')"
DB_GPG="${SOURCE_DIR}/db-${BACKUP_ID}.sql.gz.gpg"
STORAGE_GPG="${SOURCE_DIR}/storage-${BACKUP_ID}.tar.gz.gpg"
[ -f "${DB_GPG}" ] && [ -f "${STORAGE_GPG}" ]

MANIFEST="${WORK_DIR}/manifest.json"
DB_DUMP="${WORK_DIR}/database.sql.gz"
STORAGE_ARCHIVE="${WORK_DIR}/storage.tar.gz"
for pair in "${LATEST_MANIFEST}:${MANIFEST}" "${DB_GPG}:${DB_DUMP}" "${STORAGE_GPG}:${STORAGE_ARCHIVE}"; do
  encrypted="${pair%%:*}"
  decrypted="${pair#*:}"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "${PASSPHRASE_FILE}" \
    --decrypt --output "${decrypted}" "${encrypted}" 2>/dev/null
done

echo "$(jq -r '.database.sha256' "${MANIFEST}")  ${DB_DUMP}" | sha256sum --check --status
echo "$(jq -r '.storage.sha256' "${MANIFEST}")  ${STORAGE_ARCHIVE}" | sha256sum --check --status
gunzip -t "${DB_DUMP}"
tar -tzf "${STORAGE_ARCHIVE}" >/dev/null
if tar -tzf "${STORAGE_ARCHIVE}" | awk '/^\// || /(^|\/)\.\.($|\/)/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "ERROR: storage archive contains unsafe path" >&2
  false
fi
status_set_stage decrypted succeeded "Database, storage, and manifest decrypted and verified"

CURRENT_STAGE="restored"
log "Restoring backup ${BACKUP_ID} into disposable database ${RESTORE_DATABASE_NAME}."
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${RESTORE_DATABASE_NAME}\" WITH (FORCE);" >/dev/null
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${RESTORE_DATABASE_NAME}\";" >/dev/null
RESTORE_DB_CREATED=true
gunzip -c "${DB_DUMP}" | psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 >/dev/null

table_check="$(psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -Atc "SELECT to_regclass('public.schema_migrations') IS NOT NULL AND to_regclass('public.documents') IS NOT NULL;")"
[ "${table_check}" = "t" ]
psql "${RESTORE_DATABASE_URL}" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM documents;' >/dev/null

RESTORED_STORAGE="${WORK_DIR}/restored-storage"
mkdir -p "${RESTORED_STORAGE}"
tar -xzf "${STORAGE_ARCHIVE}" -C "${RESTORED_STORAGE}"
ARCHIVE_ROOT="${RESTORED_STORAGE}/$(basename "${STORAGE_PATH}")"
checked=0
matched=0
while IFS=$'\t' read -r expected_hash relative_path; do
  [ -n "${relative_path}" ] || continue
  if [[ "${relative_path}" = /* || "${relative_path}" = ../* || "${relative_path}" = *'/../'* ]]; then
    echo "ERROR: manifest contains unsafe original path" >&2
    false
  fi
  checked=$((checked + 1))
  restored_file="${ARCHIVE_ROOT}/${relative_path}"
  if [ -f "${restored_file}" ] && [ "$(sha256sum "${restored_file}" | awk '{print $1}')" = "${expected_hash}" ]; then
    matched=$((matched + 1))
  fi
done < <(jq -r '.sampledOriginals[] | [.sha256, .path] | @tsv' "${MANIFEST}")
[ "${checked}" -eq "${matched}" ]

status_set_stage restored succeeded "Disposable database and sampled originals verified"
status_mark_restore_complete "${checked}" "${matched}"
date +%s > "${BACKUP_DIR}/last-restore-verify-at"
log "Restore drill passed: database restored; ${matched}/${checked} sampled originals matched."
