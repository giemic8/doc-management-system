#!/usr/bin/env bash
#
# entrypoint.sh — daily backup scheduler.
#
# Design choice: a plain sleep-loop instead of a cron daemon. Rationale:
#   - No extra process (cron/crond) to manage, log-forward, or debug inside
#     the container — stdout from the loop and the backup script both go
#     straight to `docker logs`, matching how the existing `worker` service
#     runs a single long-lived foreground process.
#   - Simpler failure semantics: if run-backup.sh's `set -euo pipefail`
#     causes a non-zero exit, we log it and keep looping (a single failed
#     run doesn't kill the container / stop future attempts), whereas cron
#     silently swallowing failures is a common footgun.
#   - Good enough for a once-a-day cadence; a real cron daemon would only
#     pay for itself with more complex multi-schedule needs.
#
# Runs run-backup.sh immediately on startup (so a fresh deploy gets a backup
# right away rather than waiting up to 24h), then every 24h thereafter.

set -uo pipefail

BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"

echo "[entrypoint] Backup service starting. Interval: ${BACKUP_INTERVAL_SECONDS}s"

while true; do
  echo "[entrypoint] $(date -u +'%Y-%m-%dT%H:%M:%SZ') - Running scheduled backup..."
  if ./scripts/run-backup.sh; then
    echo "[entrypoint] Backup run finished successfully."
  else
    echo "[entrypoint] Backup run FAILED (see logs above). Will retry at next interval."
  fi
  echo "[entrypoint] Sleeping for ${BACKUP_INTERVAL_SECONDS}s until next run..."
  sleep "${BACKUP_INTERVAL_SECONDS}"
done
