import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';
import { buildDocumentAclWhereClause } from '../services/acl.service';

const router = Router();

// GET /api/audit-logs
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Ticket #34 -- the audit trail stays complete for everybody: hiding
    // that something happened would defeat the point of an audit log. What
    // it must not do is leak the CONTENT it is recording, and a document
    // title is content. So a row about a document the caller cannot read
    // keeps its action, actor and timestamp, and loses the title.
    const params: any[] = [];
    const visibleToCaller = buildDocumentAclWhereClause(
      { userId: req.user!.id, role: req.user!.role },
      params
    );

    const result = await query(
      `
      SELECT a.*, u.name as user_name, u.email as user_email,
             CASE WHEN d.id IS NOT NULL AND (${visibleToCaller}) THEN d.title END AS document_title,
             (d.id IS NOT NULL AND NOT (${visibleToCaller})) AS document_redacted
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN documents d ON a.document_id = d.id
      ORDER BY a.created_at DESC
      LIMIT 100;
      `,
      params
    );
    return res.json({ audit_logs: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
