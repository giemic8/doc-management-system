import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

const VALID_FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'dropdown'];

// GET /api/custom-fields?doc_type=...
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { doc_type } = req.query;
    const result = doc_type
      ? await query(`SELECT * FROM custom_fields WHERE doc_type = $1 ORDER BY created_at ASC;`, [doc_type])
      : await query(`SELECT * FROM custom_fields ORDER BY created_at ASC;`);
    return res.json({ custom_fields: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/custom-fields (admin: define a field bound to a document type)
router.post('/', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { name, field_type, doc_type, required = false, options } = req.body;

  if (!name || !field_type || !doc_type) {
    return res.status(400).json({ error: 'name, field_type, and doc_type are required' });
  }
  if (!VALID_FIELD_TYPES.includes(field_type)) {
    return res.status(400).json({ error: `field_type must be one of: ${VALID_FIELD_TYPES.join(', ')}` });
  }
  if (field_type === 'dropdown' && (!Array.isArray(options) || options.length === 0)) {
    return res.status(400).json({ error: 'dropdown fields require a non-empty options array' });
  }

  try {
    const result = await query(
      `INSERT INTO custom_fields (name, field_type, doc_type, required, options) VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
      [name, field_type, doc_type, required, options ? JSON.stringify(options) : null]
    );
    return res.status(201).json({ custom_field: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/custom-fields/:id
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(`DELETE FROM custom_fields WHERE id = $1 RETURNING id;`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Custom field not found' });
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
