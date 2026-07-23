import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';

const router = Router();

// GET /api/audit-logs
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`
      SELECT a.*, u.name as user_name, u.email as user_email, d.title as document_title
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN documents d ON a.document_id = d.id
      ORDER BY a.created_at DESC
      LIMIT 100;
    `);
    return res.json({ audit_logs: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
