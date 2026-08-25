#!/usr/bin/env bash

# Shared, atomic status writer for backup and restore jobs. Requires jq.

STATUS_FILE="${BACKUP_STATUS_FILE:-${BACKUP_DIR:-/backups}/last-backup-status.json}"

status_now() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

status_replace() {
  local filter="$1"
  shift
  local temporary_file="${STATUS_FILE}.tmp.$$"

  mkdir -p "$(dirname "${STATUS_FILE}")"
  jq "$@" "${filter}" "${STATUS_FILE}" > "${temporary_file}"
  mv "${temporary_file}" "${STATUS_FILE}"
}

status_init() {
  local backup_id="$1"
  local started_at
  started_at="$(status_now)"
  mkdir -p "$(dirname "${STATUS_FILE}")"

  local previous_args=()
  if [ -f "${STATUS_FILE}" ] && jq -e . "${STATUS_FILE}" >/dev/null 2>&1; then
    previous_args=(--slurpfile previous "${STATUS_FILE}")
  else
    previous_args=(--argjson previous '[]')
  fi

  jq -n "${previous_args[@]}" \
    --arg backup_id "${backup_id}" \
    --arg started_at "${started_at}" \
    '{
      version: 2,
      backupId: $backup_id,
      timestamp: $started_at,
      startedAt: $started_at,
      completedAt: null,
      lastRestoreAt: ($previous[0].lastRestoreAt // null),
      dbBackupSizeBytes: 0,
      mediaBackupSizeBytes: 0,
      success: false,
      stages: {
        created: { state: "pending", at: null },
        replicated: { state: "pending", at: null },
        uploaded: { state: "pending", at: null },
        retained: { state: "pending", at: null },
        decrypted: ($previous[0].stages.decrypted // { state: "pending", at: null }),
        restored: ($previous[0].stages.restored // { state: "pending", at: null })
      },
      restore: ($previous[0].restore // {
        backupId: null,
        databaseVerified: false,
        sampledOriginalsChecked: 0,
        sampledOriginalsMatched: 0
      }),
      dashboardAlert: { active: false, message: null },
      emailAlert: { attempted: false, sent: false, detail: null }
    }' > "${STATUS_FILE}.tmp.$$"
  mv "${STATUS_FILE}.tmp.$$" "${STATUS_FILE}"
}

status_set_stage() {
  local stage="$1"
  local state="$2"
  local detail="${3:-}"
  local at
  at="$(status_now)"

  status_replace \
    '.stages[$stage] = ({state: $state, at: $at} + (if $detail == "" then {} else {detail: $detail} end))' \
    --arg stage "${stage}" --arg state "${state}" --arg at "${at}" --arg detail "${detail}"
}

status_set_sizes() {
  local db_size="$1"
  local media_size="$2"
  status_replace '.dbBackupSizeBytes = $db_size | .mediaBackupSizeBytes = $media_size' \
    --argjson db_size "${db_size}" --argjson media_size "${media_size}"
}

status_mark_backup_complete() {
  local completed_at
  completed_at="$(status_now)"
  status_replace \
    '.timestamp = $completed_at | .completedAt = $completed_at | .success = true | .error = null | .dashboardAlert = {active: false, message: null}' \
    --arg completed_at "${completed_at}"
}

status_mark_restore_complete() {
  local checked="$1"
  local matched="$2"
  local completed_at
  completed_at="$(status_now)"
  status_replace \
    '.timestamp = $completed_at | .completedAt = $completed_at | .lastRestoreAt = $completed_at | .success = true | .error = null | .restore = {backupId: .backupId, databaseVerified: true, sampledOriginalsChecked: $checked, sampledOriginalsMatched: $matched} | .dashboardAlert = {active: false, message: null}' \
    --arg completed_at "${completed_at}" --argjson checked "${checked}" --argjson matched "${matched}"
}

status_mark_failure() {
  local message="$1"
  local completed_at
  completed_at="$(status_now)"
  status_replace \
    '.timestamp = $completed_at | .completedAt = $completed_at | .success = false | .error = $message | .dashboardAlert = {active: true, message: $message}' \
    --arg completed_at "${completed_at}" --arg message "${message}"
}

status_set_email_alert() {
  local attempted="$1"
  local sent="$2"
  local detail="$3"
  status_replace '.emailAlert = {attempted: $attempted, sent: $sent, detail: $detail}' \
    --argjson attempted "${attempted}" --argjson sent "${sent}" --arg detail "${detail}"
}
