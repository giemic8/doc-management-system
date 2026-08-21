#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=status-lib.sh
source "${SCRIPT_DIR}/status-lib.sh"

SUBJECT="${1:-DocVault backup failure}"
MESSAGE="${2:-Backup or restore verification failed. Check operations dashboard and backup service logs.}"

if [ -z "${SMTP_URL:-}" ] || [ -z "${BACKUP_ALERT_EMAIL_TO:-}" ] || [ -z "${BACKUP_ALERT_EMAIL_FROM:-}" ]; then
  status_set_email_alert false false "SMTP alerting is not configured"
  echo "[backup-alert] SMTP alerting not configured; dashboard alert remains active."
  exit 0
fi

MAIL_FILE="$(mktemp /tmp/docvault-backup-mail.XXXXXX)"
CURL_CONFIG="$(mktemp /tmp/docvault-backup-curl.XXXXXX)"
cleanup() {
  rm -f "${MAIL_FILE}" "${CURL_CONFIG}"
}
trap cleanup EXIT
chmod 600 "${MAIL_FILE}" "${CURL_CONFIG}"

{
  printf 'From: %s\r\n' "${BACKUP_ALERT_EMAIL_FROM}"
  printf 'To: %s\r\n' "${BACKUP_ALERT_EMAIL_TO}"
  printf 'Subject: %s\r\n' "${SUBJECT}"
  printf 'Content-Type: text/plain; charset=UTF-8\r\n'
  printf '\r\n%s\r\n' "${MESSAGE}"
} > "${MAIL_FILE}"

{
  printf 'url = "%s"\n' "${SMTP_URL}"
  printf 'mail-from = "%s"\n' "${BACKUP_ALERT_EMAIL_FROM}"
  printf 'mail-rcpt = "%s"\n' "${BACKUP_ALERT_EMAIL_TO}"
  printf 'upload-file = "%s"\n' "${MAIL_FILE}"
  printf 'ssl-reqd\n'
  printf 'silent\nshow-error\nfail\n'
  if [ -n "${SMTP_USERNAME:-}" ]; then
    printf 'user = "%s:%s"\n' "${SMTP_USERNAME}" "${SMTP_PASSWORD:-}"
  fi
} > "${CURL_CONFIG}"

status_set_email_alert true false "SMTP delivery attempted"
if curl --config "${CURL_CONFIG}"; then
  status_set_email_alert true true "Failure email sent"
  echo "[backup-alert] Failure email sent."
else
  status_set_email_alert true false "SMTP delivery failed"
  echo "[backup-alert] SMTP delivery failed; dashboard alert remains active." >&2
fi
