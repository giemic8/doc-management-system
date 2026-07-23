import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

const VALID_EVENTS = ['document.created', 'document.processed', 'workflow.triggered', 'document.deleted'];

// GET /api/webhooks (list endpoints, secrets redacted)
router.get('/', authenticateToken, requireRole(['admin']), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, url, events, is_active, created_at, updated_at FROM webhook_endpoints ORDER BY created_at DESC;`
    );
    return res.json({ webhooks: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/webhooks (create endpoint; generates the signing secret)
router.post('/', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { url, events } = req.body;
  if (!url || !Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'url and a non-empty events array are required' });
  }
  const invalidEvents = events.filter((e: string) => !VALID_EVENTS.includes(e));
  if (invalidEvents.length > 0) {
    return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
  }

  try {
    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const result = await query(
      `INSERT INTO webhook_endpoints (url, secret, events, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, url, secret, events, is_active, created_at;`,
      [url, secret, JSON.stringify(events), req.user!.id]
    );
    // Secret is only ever returned once, at creation time.
    return res.status(201).json({ webhook: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/webhooks/:id (update url/events/active state)
router.put('/:id', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { url, events, is_active } = req.body;

  try {
    const result = await query(
      `UPDATE webhook_endpoints
       SET url = COALESCE($1, url),
           events = COALESCE($2, events),
           is_active = COALESCE($3, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, url, events, is_active, updated_at;`,
      [url, events ? JSON.stringify(events) : null, is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    return res.json({ webhook: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/webhooks/:id
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM webhook_endpoints WHERE id = $1 RETURNING id;`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook endpoint not found' });
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/webhooks/:id/deliveries (delivery log for observability)
router.get('/:id/deliveries', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM webhook_deliveries WHERE webhook_endpoint_id = $1 ORDER BY created_at DESC LIMIT 100;`,
      [req.params.id]
    );
    return res.json({ deliveries: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
