import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../database/db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { buildIcsFeed, DocumentForFeed } from '../services/icalFeed.service';
import { buildDocumentAclWhereClause } from '../services/acl.service';

const router = Router();

/**
 * POST /api/calendar/feed-token
 *
 * Generates a new opaque calendar feed token for the current user,
 * revoking any previously issued token (regeneration = rotate). The raw
 * token is only ever returned here, at creation time — subsequent
 * GET /api/calendar/feed-token calls only report whether a token exists,
 * never the value itself, to avoid re-exposing the secret.
 */
router.post('/feed-token', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // Revoke any existing active token(s) for this user before issuing a
    // new one, so regeneration invalidates old calendar subscriptions.
    await query(
      `UPDATE calendar_feed_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL;`,
      [userId]
    );

    const token = crypto.randomBytes(32).toString('hex');
    await query(`INSERT INTO calendar_feed_tokens (user_id, token) VALUES ($1, $2);`, [userId, token]);
    await query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address)
       VALUES ($1, 'calendar_feed_token_rotated', $2, $3);`,
      [userId, JSON.stringify({ rotated: true }), req.ip ?? null]
    );

    return res.status(201).json({ feedUrl: `/api/calendar/feed.ics?token=${token}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calendar/feed-token
 *
 * Reports whether the current user has an active (non-revoked) feed
 * token, without ever exposing the raw token value again.
 */
router.get('/feed-token', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await query(
      `SELECT 1 FROM calendar_feed_tokens WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1;`,
      [userId]
    );
    return res.json({ hasToken: result.rows.length > 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calendar/feed.ics?token=...
 *
 * Public endpoint (no JWT) — calendar apps like Apple/Google/Outlook
 * cannot send custom Authorization headers when subscribing to a feed
 * URL, so auth here is via the opaque `token` query param instead,
 * resolved against calendar_feed_tokens. Returns 403 if the token is
 * missing, unknown, or revoked.
 */
router.get('/feed.ics', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) {
      return res.status(403).json({ error: 'Missing calendar feed token' });
    }

    const tokenResult = await query(
      `SELECT cft.user_id, u.role
       FROM calendar_feed_tokens cft
       JOIN users u ON u.id = cft.user_id
       WHERE cft.token = $1 AND cft.revoked_at IS NULL LIMIT 1;`,
      [token]
    );
    if (tokenResult.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid or revoked calendar feed token' });
    }

    const userId = tokenResult.rows[0].user_id;
    const userRole = tokenResult.rows[0].role;
    const params: any[] = [];
    const aclClause = buildDocumentAclWhereClause({ userId, role: userRole }, params);

    // Include documents with a due_date (payment due dates for invoices,
    // and — per the schema note in icalFeed.service.ts — notice-period
    // deadlines for contract-type documents, since there's no dedicated
    // column for that yet).
    const docsResult = await query(
      `SELECT d.id, d.title, d.doc_type, d.sender, d.due_date, d.amount, d.currency
       FROM documents d
       WHERE d.is_archived = FALSE AND d.due_date IS NOT NULL
       ${aclClause ? `AND ${aclClause}` : ''}
       ORDER BY due_date ASC;`,
      params
    );

    const documents: DocumentForFeed[] = docsResult.rows;
    const ics = buildIcsFeed(documents);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    return res.status(200).send(ics);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
