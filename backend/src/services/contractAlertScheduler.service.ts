import { query } from '../database/db';
import { findContractsNeedingAlert, ContractRow } from './contractWatcher.service';

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Periodically (default hourly) checks all contracts for ones whose
 * cancellation notice deadline is approaching and haven't been alerted yet
 * (see findContractsNeedingAlert), then "sends an alert" for each one.
 *
 * MVP NOTE: this codebase has no outbound SMTP/push-notification
 * infrastructure yet (emailImport.service.ts only handles INBOUND IMAP
 * polling for document ingestion). Building a full outbound email/push
 * system is out of scope for this ticket, so as a pragmatic substitute we
 * write the alert into the existing audit_logs table
 * (action: 'contract_alert_triggered') and mark alert_sent_at on the
 * contract_details row so it isn't re-alerted on the next check. Wiring
 * this up to real email/push delivery is a natural follow-up ticket.
 */
export function startContractAlertScheduler(checkIntervalMs: number = 60 * 60 * 1000) {
  if (intervalHandle) return; // already running

  intervalHandle = setInterval(async () => {
    try {
      const res = await query(`
        SELECT cd.document_id, cd.customer_number, cd.vendor_address, cd.notice_period_days,
               cd.cancellation_deadline, cd.contract_end_date, cd.alert_sent_at,
               d.title AS document_title, d.sender AS vendor_name
        FROM contract_details cd
        JOIN documents d ON d.id = cd.document_id;
      `);

      const contracts: ContractRow[] = res.rows;
      const needingAlert = findContractsNeedingAlert(contracts);

      for (const contract of needingAlert) {
        await query(
          `INSERT INTO audit_logs (document_id, action, details) VALUES ($1, 'contract_alert_triggered', $2);`,
          [
            contract.document_id,
            JSON.stringify({
              document_title: contract.document_title,
              vendor_name: contract.vendor_name,
              customer_number: contract.customer_number,
              cancellation_deadline: contract.cancellation_deadline,
              contract_end_date: contract.contract_end_date,
            }),
          ]
        );

        await query(
          `UPDATE contract_details SET alert_sent_at = CURRENT_TIMESTAMP WHERE document_id = $1;`,
          [contract.document_id]
        );
      }

      if (needingAlert.length > 0) {
        console.log(`Contract alert scheduler: triggered ${needingAlert.length} alert(s).`);
      }
    } catch (err: any) {
      console.error('Contract alert scheduler error:', err.message);
    }
  }, checkIntervalMs);
}

export function stopContractAlertScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
