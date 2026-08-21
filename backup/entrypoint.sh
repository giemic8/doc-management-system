#!/usr/bin/env bash

set -uo pipefail

BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
RESTORE_VERIFY_INTERVAL_SECONDS="${RESTORE_VERIFY_INTERVAL_SECONDS:-604800}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
VERIFY_MARKER="${BACKUP_DIR}/last-restore-verify-at"

echo "[entrypoint] Backup scheduler started."

while true; do
  if ./scripts/run-backup.sh; then
    now="$(date +%s)"
    last_verify=0
    if [ -f "${VERIFY_MARKER}" ]; then
      last_verify="$(cat "${VERIFY_MARKER}" 2>/dev/null || echo 0)"
    fi

    if [ $((now - last_verify)) -ge "${RESTORE_VERIFY_INTERVAL_SECONDS}" ]; then
      if ! ./scripts/verify-restore.sh; then
        echo "[entrypoint] Restore drill failed; next backup schedule remains active." >&2
      fi
    fi
  else
    echo "[entrypoint] Backup failed; next backup schedule remains active." >&2
  fi

  sleep "${BACKUP_INTERVAL_SECONDS}"
done
