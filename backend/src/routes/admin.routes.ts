import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

const MFA_REQUIRED_KEY = 'mfa_required_for_editors';

// GET /api/admin/settings/mfa-required
router.get(
  '/settings/mfa-required',
  authenticateToken,
  requireRole(['admin']),
  async (_req: AuthRequest, res: Response) => {
    try {
      const result = await query(`SELECT value FROM org_settings WHERE key = $1;`, [MFA_REQUIRED_KEY]);
      const required = result.rows[0]?.value === true;
      return res.json({ required });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// PUT /api/admin/settings/mfa-required
router.put(
  '/settings/mfa-required',
  authenticateToken,
  requireRole(['admin']),
  async (req: AuthRequest, res: Response) => {
    const { required } = req.body;
    if (typeof required !== 'boolean') {
      return res.status(400).json({ error: 'required must be a boolean' });
    }

    try {
      await query(
        `INSERT INTO org_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP;`,
        [MFA_REQUIRED_KEY, JSON.stringify(required)]
      );
      return res.json({ required });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

export default router;
