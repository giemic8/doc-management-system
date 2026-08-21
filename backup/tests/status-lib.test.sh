#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
TEST_DIR="$(mktemp -d /tmp/docvault-status-test.XXXXXX)"
trap 'rm -rf "${TEST_DIR}"' EXIT

export BACKUP_STATUS_FILE="${TEST_DIR}/status.json"
# shellcheck source=../scripts/status-lib.sh
source "${SCRIPT_DIR}/status-lib.sh"

status_init test-backup
status_set_stage created succeeded "created"
status_set_stage replicated succeeded "replicated"
status_set_stage uploaded skipped "local"
status_mark_backup_complete

jq -e '.backupId == "test-backup"' "${BACKUP_STATUS_FILE}" >/dev/null
jq -e '.stages.created.state == "succeeded"' "${BACKUP_STATUS_FILE}" >/dev/null
jq -e '.stages.uploaded.state == "skipped"' "${BACKUP_STATUS_FILE}" >/dev/null
jq -e '.success == true and .dashboardAlert.active == false' "${BACKUP_STATUS_FILE}" >/dev/null

status_set_stage restored failed "restore failed"
status_mark_failure "restore failed"
status_set_email_alert true false "SMTP delivery failed"

jq -e '.success == false and .dashboardAlert.active == true' "${BACKUP_STATUS_FILE}" >/dev/null
jq -e '.emailAlert.attempted == true and .emailAlert.sent == false' "${BACKUP_STATUS_FILE}" >/dev/null

printf '{ malformed\n' > "${BACKUP_STATUS_FILE}"
status_init recovered-status
jq -e '.backupId == "recovered-status" and .stages.created.state == "pending"' "${BACKUP_STATUS_FILE}" >/dev/null

echo "status-lib tests passed"
