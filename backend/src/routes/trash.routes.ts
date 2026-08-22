import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { requireDocumentPermission } from '../middleware/documentAcl';
import { buildDocumentAclWhereClause } from '../services/acl.service';
import {
  TRASH_RETENTION_DAYS,
  TrashError,
  describeTrashedDocument,
  purgeDocument,
  purgeExpiredDocuments,
  restoreDocument,
  trashDocument,
} from '../services/trash.service';

/**
 * Ticket #33 -- trash and purge routes, mounted at /api/documents.
 *
 * This router is registered BEFORE document.routes.ts in app.ts on
 * purpose: `GET /api/documents/:id` would otherwise swallow
 * `GET /api/documents/trash` and treat "trash" as a document id.
 */
export const trashRouter = Router();

function respondToTrashError(err: any, res: Response) {
  if (err instanceof TrashError) {
    return res.status(err.status).json({ error: err.message, reason: err.reason, ...err.details });
  }
  return res.status(500).json({ error: err.message });
}

function actorFrom(req: AuthRequest) {
  return { id: req.user?.id, ip: req.ip, role: req.user?.role };
}

// GET /api/documents/trash (documents in the 90-day recovery window)
trashRouter.get('/trash', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const params: any[] = [];
    const aclClause = buildDocumentAclWhereClause({ userId: req.user!.id, role: req.user!.role }, params);
    params.push(limit, offset);

    const result = await query(
      `SELECT d.*, u.name AS trashed_by_name,
              COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color))
                FILTER (WHERE t.id IS NOT NULL), '[]'
              ) AS tags,
              (
                SELECT COUNT(*)::int FROM document_share_links l
                WHERE l.document_id = d.id
                  AND l.revoked_at IS NULL
                  AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
              ) AS active_share_links
       FROM documents d
       LEFT JOIN users u ON u.id = d.trashed_by
       LEFT JOIN document_tags dt ON dt.document_id = d.id
       LEFT JOIN tags t ON t.id = dt.tag_id
       WHERE d.status = 'trashed'
       ${aclClause ? `AND ${aclClause}` : ''}
       GROUP BY d.id, u.name
       ORDER BY d.trashed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length};`,
      params
    );

    return res.json({
      documents: result.rows.map((row: any) => describeTrashedDocument(row, row.active_share_links ?? 0)),
      retentionDays: TRASH_RETENTION_DAYS,
    });
  } catch (err: any) {
    return respondToTrashError(err, res);
  }
});

// POST /api/documents/trash/purge-expired (admin: destroy everything past its recovery window)
trashRouter.post(
  '/trash/purge-expired',
  authenticateToken,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    const { confirmation, revokeShareLinks, acknowledgeBackupPolicy } = req.body ?? {};
    if (confirmation !== 'purge-expired') {
      return res.status(400).json({
        error: 'Purging expired documents requires confirmation: "purge-expired"',
        reason: 'confirmation_required',
      });
    }

    try {
      const result = await purgeExpiredDocuments(actorFrom(req), {
        revokeShareLinks: revokeShareLinks === true,
        acknowledgeBackupPolicy: acknowledgeBackupPolicy === true,
      });
      return res.json({
        purged: result.purged.map((entry) => entry.documentId),
        skipped: result.skipped,
      });
    } catch (err: any) {
      return respondToTrashError(err, res);
    }
  }
);

async function handleTrash(req: AuthRequest, res: Response) {
  try {
    const document = await trashDocument(req.params.id, actorFrom(req));
    return res.json({ document });
  } catch (err: any) {
    return respondToTrashError(err, res);
  }
}

// POST /api/documents/:id/trash and DELETE /api/documents/:id (normal delete)
trashRouter.post(
  '/:id/trash',
  authenticateToken,
  requireDocumentPermission('delete', (req) => req.params.id, 'trash_document'),
  handleTrash
);
trashRouter.delete(
  '/:id',
  authenticateToken,
  requireDocumentPermission('delete', (req) => req.params.id, 'trash_document'),
  handleTrash
);

// POST /api/documents/:id/restore (back to the state held before trashing)
trashRouter.post(
  '/:id/restore',
  authenticateToken,
  requireDocumentPermission('delete', (req) => req.params.id, 'restore_document'),
  async (req: AuthRequest, res: Response) => {
    try {
      const document = await restoreDocument(req.params.id, actorFrom(req));
      return res.json({ document });
    } catch (err: any) {
      return respondToTrashError(err, res);
    }
  }
);

// POST /api/documents/:id/purge (admin + typed confirmation: irreversible)
trashRouter.post(
  '/:id/purge',
  authenticateToken,
  requireRole(['admin']),
  // Ticket #34 -- admin is necessary but not sufficient: a purge is a delete,
  // and the space rule binds admins. Nobody destroys what they cannot read.
  requireDocumentPermission('delete', (req) => req.params.id, 'purge_document'),
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { confirmation, revokeShareLinks, acknowledgeBackupPolicy } = req.body ?? {};

    // Explicit authorization is a typed confirmation of the exact document
    // id, mirroring the db:reset --confirm=<database> convention: no purge
    // can happen as a side effect of a mistyped or replayed request.
    if (confirmation !== id) {
      return res.status(400).json({
        error: 'Purging requires confirmation with the document id',
        reason: 'confirmation_required',
      });
    }

    try {
      const result = await purgeDocument(id, actorFrom(req), {
        revokeShareLinks: revokeShareLinks === true,
        acknowledgeBackupPolicy: acknowledgeBackupPolicy === true,
      });
      return res.json({ purged: true, ...result });
    } catch (err: any) {
      return respondToTrashError(err, res);
    }
  }
);

export default trashRouter;
