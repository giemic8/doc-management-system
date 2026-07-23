import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';

const router = Router();

// GET /api/tags
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT * FROM tags ORDER BY name ASC;`);
    return res.json({ tags: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/tags
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { name, color = '#3B82F6' } = req.body;
    if (!name) return res.status(400).json({ error: 'Tag name required' });

    const result = await query(
      `INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING *;`,
      [name, color]
    );
    return res.status(201).json({ tag: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
