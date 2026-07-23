import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';
import { StorageService } from '../services/storage.service';
import { addDocumentProcessingJob } from '../services/queue.service';

const router = Router();
const upload = multer({ dest: path.join(__dirname, '../../../storage/tmp') });

// GET /api/documents (Search, filter, paginate)
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { search, tag, doc_type, status, limit = 50, offset = 0 } = req.query;

    let queryText = `
      SELECT d.*, 
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)) 
          FILTER (WHERE t.id IS NOT NULL), '[]'
        ) as tags
      FROM documents d
      LEFT JOIN document_tags dt ON d.id = dt.document_id
      LEFT JOIN tags t ON dt.tag_id = t.id
      WHERE d.is_archived = FALSE
    `;
    const params: any[] = [];

    if (search) {
      params.push(`%${search}%`);
      queryText += ` AND (d.title ILIKE $${params.length} OR d.ocr_text ILIKE $${params.length} OR d.sender ILIKE $${params.length} OR d.summary ILIKE $${params.length})`;
    }

    if (doc_type) {
      params.push(doc_type);
      queryText += ` AND d.doc_type = $${params.length}`;
    }

    if (status) {
      params.push(status);
      queryText += ` AND d.status = $${params.length}`;
    }

    queryText += ` GROUP BY d.id ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(queryText, params);
    return res.json({ documents: result.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id (Detail view)
router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const docRes = await query(`
      SELECT d.*, 
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)) 
          FILTER (WHERE t.id IS NOT NULL), '[]'
        ) as tags
      FROM documents d
      LEFT JOIN document_tags dt ON d.id = dt.document_id
      LEFT JOIN tags t ON dt.tag_id = t.id
      WHERE d.id = $1
      GROUP BY d.id;
    `, [id]);

    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Fetch custom fields
    const customFieldsRes = await query(`
      SELECT cf.id, cf.name, cf.field_type, dcf.value_text, dcf.value_number, dcf.value_date, dcf.value_boolean
      FROM document_custom_fields dcf
      JOIN custom_fields cf ON dcf.custom_field_id = cf.id
      WHERE dcf.document_id = $1;
    `, [id]);

    // Fetch audit logs
    const auditRes = await query(`
      SELECT a.*, u.name as user_name
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.document_id = $1
      ORDER BY a.created_at DESC;
    `, [id]);

    return res.json({
      document: docRes.rows[0],
      custom_fields: customFieldsRes.rows,
      audit_logs: auditRes.rows,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/upload
router.post('/upload', authenticateToken, upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const tempPath = req.file.path;
    const originalName = req.file.originalname;
    const mimeType = req.file.mimetype || 'application/pdf';
    const fileHash = await StorageService.calculateFileHash(tempPath);
    
    const targetPath = StorageService.getOriginalFilePath(`${Date.now()}_${originalName}`);
    fs.renameSync(tempPath, targetPath);

    const dbResult = await query(
      `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
       RETURNING *;`,
      [originalName, originalName, targetPath, req.file.size, mimeType, fileHash, req.user?.id]
    );

    const doc = dbResult.rows[0];

    // Audit log
    await query(`INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'upload', $3);`,
      [doc.id, req.user?.id, JSON.stringify({ filename: originalName, size: req.file.size })]
    );

    // Queue for OCR & AI
    await addDocumentProcessingJob(doc.id, targetPath);

    return res.status(201).json({ document: doc });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/file (Download/Serve PDF file)
router.get('/:id/file', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const docRes = await query(`SELECT file_path, derived_file_path, original_filename, mime_type FROM documents WHERE id = $1;`, [id]);
    
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docRes.rows[0];
    const servePath = doc.derived_file_path && fs.existsSync(doc.derived_file_path)
      ? doc.derived_file_path
      : doc.file_path;

    if (!fs.existsSync(servePath)) {
      return res.status(404).json({ error: 'File on disk not found' });
    }

    res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_filename)}"`);
    fs.createReadStream(servePath).pipe(res);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/documents/:id (Update metadata)
router.put('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { title, doc_type, sender, recipient, document_date, due_date, amount, summary, tags } = req.body;

    const docRes = await query(
      `UPDATE documents 
       SET title = COALESCE($1, title),
           doc_type = COALESCE($2, doc_type),
           sender = COALESCE($3, sender),
           recipient = COALESCE($4, recipient),
           document_date = COALESCE($5, document_date),
           due_date = COALESCE($6, due_date),
           amount = COALESCE($7, amount),
           summary = COALESCE($8, summary),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *;`,
      [title, doc_type, sender, recipient, document_date, due_date, amount, summary, id]
    );

    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Update tags if provided
    if (Array.isArray(tags)) {
      await query(`DELETE FROM document_tags WHERE document_id = $1;`, [id]);
      for (const tagId of tags) {
        await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`, [id, tagId]);
      }
    }

    await query(`INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'update_metadata', $3);`,
      [id, req.user?.id, JSON.stringify(req.body)]
    );

    return res.json({ document: docRes.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
