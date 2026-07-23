import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';

const router = Router();

// GET /api/workflows
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`SELECT * FROM workflows ORDER BY created_at DESC;`);
    return res.json({ workflows: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/workflows
router.post('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { name, trigger_event, condition_json, actions_json } = req.body;
    if (!name || !trigger_event) {
      return res.status(400).json({ error: 'Workflow name and trigger_event required' });
    }

    const result = await query(
      `INSERT INTO workflows (name, trigger_event, condition_json, actions_json)
       VALUES ($1, $2, $3, $4) RETURNING *;`,
      [name, trigger_event, JSON.stringify(condition_json || {}), JSON.stringify(actions_json || [])]
    );

    return res.status(201).json({ workflow: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
