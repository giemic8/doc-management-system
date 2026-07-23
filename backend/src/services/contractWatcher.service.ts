/**
 * Pure, testable helpers for deriving contract status and finding contracts
 * that need an expiration alert. No I/O here — see
 * contractAlertScheduler.service.ts for the side-effecting job that uses
 * these.
 */

export const NOTICE_DEADLINE_WARNING_DAYS = 30;

export type ContractStatus = 'active' | 'notice_deadline_nearing' | 'expired';

export interface ContractRow {
  document_id: string;
  cancellation_deadline: Date | string | null;
  alert_sent_at: Date | string | null;
  [key: string]: any;
}

/**
 * Derives the display status of a contract based on its cancellation
 * notice deadline:
 *  - 'expired' if the deadline is strictly in the past.
 *  - 'notice_deadline_nearing' if the deadline is today or within the next
 *    NOTICE_DEADLINE_WARNING_DAYS days (inclusive of the boundary).
 *  - 'active' otherwise, including when no deadline has been set yet
 *    (nothing to warn about).
 */
export function deriveContractStatus(
  cancellationDeadline: Date | string | null | undefined,
  now: Date = new Date()
): ContractStatus {
  if (cancellationDeadline === null || cancellationDeadline === undefined) {
    return 'active';
  }

  const deadline = new Date(cancellationDeadline);
  if (Number.isNaN(deadline.getTime())) {
    return 'active';
  }

  // Compare at day granularity so "today" counts as the boundary, not as
  // already expired due to time-of-day differences.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nowDay = startOfDay(now);
  const deadlineDay = startOfDay(deadline);

  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((deadlineDay.getTime() - nowDay.getTime()) / msPerDay);

  if (diffDays < 0) {
    return 'expired';
  }
  if (diffDays <= NOTICE_DEADLINE_WARNING_DAYS) {
    return 'notice_deadline_nearing';
  }
  return 'active';
}

/**
 * Filters contracts down to those needing an alert: status is
 * 'notice_deadline_nearing' AND no alert has been sent yet.
 */
export function findContractsNeedingAlert(contracts: ContractRow[], now: Date = new Date()): ContractRow[] {
  return contracts.filter((c) => {
    if (c.alert_sent_at) return false;
    return deriveContractStatus(c.cancellation_deadline, now) === 'notice_deadline_nearing';
  });
}
