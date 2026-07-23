import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { encryptSecret } from '../services/crypto.service';
import { pollMailbox, ImapConfig } from '../services/emailImport.service';
import { decryptSecret } from '../services/crypto.service';

const router = Router();

// GET /api/email-import/config (admin; password never returned)
router.get('/config', authenticateToken, requireRole(['admin']), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, host, port, secure, username, poll_interval_minutes, is_active, last_polled_at FROM email_import_config ORDER BY created_at DESC LIMIT 1;`
    );
    return res.json({ config: result.rows[0] || null });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/email-import/config (admin; creates or replaces the single config row)
router.put('/config', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { host, port = 993, secure = true, username, password, poll_interval_minutes = 5, is_active = true } = req.body;

  if (!host || !username || !password) {
    return res.status(400).json({ error: 'host, username, and password are required' });
  }

  try {
    await query(`DELETE FROM email_import_config;`);
    const passwordEncrypted = encryptSecret(password);
    const result = await query(
      `INSERT INTO email_import_config (host, port, secure, username, password_encrypted, poll_interval_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, host, port, secure, username, poll_interval_minutes, is_active;`,
      [host, port, secure, username, passwordEncrypted, poll_interval_minutes, is_active]
    );
    return res.status(201).json({ config: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/email-import/poll-now (admin; triggers an immediate poll, useful for testing config)
router.post('/poll-now', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const configRes = await query(`SELECT * FROM email_import_config WHERE is_active = true LIMIT 1;`);
    if (configRes.rows.length === 0) {
      return res.status(400).json({ error: 'No active email import configuration found' });
    }
    const cfg = configRes.rows[0];

    const imapConfig: ImapConfig = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.username,
      password: decryptSecret(cfg.password_encrypted),
    };

    const result = await pollMailbox(imapConfig, req.user!.id);
    await query(`UPDATE email_import_config SET last_polled_at = CURRENT_TIMESTAMP WHERE id = $1;`, [cfg.id]);

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
