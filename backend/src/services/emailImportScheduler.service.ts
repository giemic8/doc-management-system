import { query } from '../database/db';
import { decryptSecret } from './crypto.service';
import { pollMailbox, ImapConfig } from './emailImport.service';

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Starts a background poller that checks the configured mailbox every
 * `checkIntervalMs` (default 1 minute) to see if it's due for a poll,
 * based on the config row's own poll_interval_minutes. Each individual
 * mailbox check still respects the configured interval; this just avoids
 * needing a full job-scheduling system for a single recurring task.
 */
export function startEmailImportScheduler(checkIntervalMs: number = 60_000) {
  if (intervalHandle) return; // already running

  intervalHandle = setInterval(async () => {
    try {
      const configRes = await query(`SELECT * FROM email_import_config WHERE is_active = true LIMIT 1;`);
      if (configRes.rows.length === 0) return;
      const cfg = configRes.rows[0];

      const dueSince = cfg.last_polled_at
        ? Date.now() - new Date(cfg.last_polled_at).getTime()
        : Infinity;
      const intervalMs = cfg.poll_interval_minutes * 60_000;
      if (dueSince < intervalMs) return;

      const imapConfig: ImapConfig = {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.username,
        password: decryptSecret(cfg.password_encrypted),
      };

      const result = await pollMailbox(imapConfig);
      await query(`UPDATE email_import_config SET last_polled_at = CURRENT_TIMESTAMP WHERE id = $1;`, [cfg.id]);
      console.log(`Email import poll: ${result.emailsScanned} scanned, ${result.documentsImported} imported, ${result.errors.length} errors`);
    } catch (err: any) {
      console.error('Email import scheduler error:', err.message);
    }
  }, checkIntervalMs);
}

export function stopEmailImportScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
