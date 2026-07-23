import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { query } from '../database/db';
import { StorageService } from '../services/storage.service';
import { addDocumentProcessingJob } from '../services/queue.service';
import { splitPdfPages, mergePdfs } from '../services/pdfTools.service';
import { dispatchWebhookEvent } from '../services/webhookDispatch.service';
import { validateCustomFieldValues, CustomFieldDefinition } from '../services/customFieldValidation.service';
import { encryptFile, decryptFile, createDecryptStream } from '../services/fileEncryption.service';
import { config } from '../config';

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

// POST /api/documents/:id/split
router.post('/:id/split', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { splitAtPage } = req.body;

  try {
    const docRes = await query(`SELECT * FROM documents WHERE id = $1;`, [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const doc = docRes.rows[0];

    const source = fs.readFileSync(doc.file_path);
    let firstBytes: Buffer, secondBytes: Buffer;
    try {
      [firstBytes, secondBytes] = await splitPdfPages(source, Number(splitAtPage));
    } catch (splitErr: any) {
      return res.status(400).json({ error: splitErr.message });
    }

    const parts = [
      { bytes: firstBytes, suffix: 'part1' },
      { bytes: secondBytes, suffix: 'part2' },
    ];

    const createdDocs = [];
    for (const part of parts) {
      const partTitle = `${doc.title.replace(/\.pdf$/i, '')}_${part.suffix}.pdf`;
      const partPath = StorageService.getOriginalFilePath(`${Date.now()}_${part.suffix}.pdf`);
      fs.writeFileSync(partPath, part.bytes);
      const partHash = crypto.createHash('sha256').update(part.bytes).digest('hex');

      const insertRes = await query(
        `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, created_by, doc_type, sender, recipient)
         VALUES ($1, $1, $2, $3, 'application/pdf', $4, 'processed', $5, $6, $7, $8)
         RETURNING *;`,
        [partTitle, partPath, part.bytes.length, partHash, req.user?.id, doc.doc_type, doc.sender, doc.recipient]
      );
      createdDocs.push(insertRes.rows[0]);
    }

    // Preserve the original file's hash in the audit log for both new records.
    for (const createdDoc of createdDocs) {
      await query(
        `INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'split', $3);`,
        [
          createdDoc.id,
          req.user?.id,
          JSON.stringify({ source_document_id: doc.id, original_file_hash: doc.file_hash, split_at_page: splitAtPage }),
        ]
      );
    }

    return res.json({ documents: createdDocs });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/merge (must be registered before /:id routes)
router.post('/merge', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentIds } = req.body;
  if (!Array.isArray(documentIds) || documentIds.length < 2) {
    return res.status(400).json({ error: 'documentIds must be an array of at least two document ids' });
  }

  try {
    const docsRes = await query(`SELECT * FROM documents WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id);`, [documentIds]);
    if (docsRes.rows.length !== documentIds.length) {
      return res.status(404).json({ error: 'One or more documents not found' });
    }
    const docs = docsRes.rows;

    const buffers = docs.map((d: any) => fs.readFileSync(d.file_path));
    const mergedBytes = await mergePdfs(buffers);
    const mergedHash = crypto.createHash('sha256').update(mergedBytes).digest('hex');

    const mergedTitle = `Merged_${Date.now()}.pdf`;
    const mergedPath = StorageService.getOriginalFilePath(mergedTitle);
    fs.writeFileSync(mergedPath, mergedBytes);

    const insertRes = await query(
      `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, created_by)
       VALUES ($1, $1, $2, $3, 'application/pdf', $4, 'processed', $5)
       RETURNING *;`,
      [mergedTitle, mergedPath, mergedBytes.length, mergedHash, req.user?.id]
    );
    const mergedDoc = insertRes.rows[0];

    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'merge', $3);`,
      [mergedDoc.id, req.user?.id, JSON.stringify({ source_document_ids: documentIds, source_file_hashes: docs.map((d: any) => d.file_hash) })]
    );

    return res.json({ document: mergedDoc });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/bulk/tag (must be registered before /:id routes)
router.post('/bulk/tag', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentIds, tagId } = req.body;
  if (!Array.isArray(documentIds) || documentIds.length === 0 || !tagId) {
    return res.status(400).json({ error: 'documentIds (non-empty array) and tagId are required' });
  }

  try {
    let updated = 0;
    for (const docId of documentIds) {
      const result = await query(
        `INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING document_id;`,
        [docId, tagId]
      );
      if (result.rows.length > 0) updated++;
    }
    return res.json({ updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/bulk/doc-type
router.post('/bulk/doc-type', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentIds, docType } = req.body;
  if (!Array.isArray(documentIds) || documentIds.length === 0 || !docType) {
    return res.status(400).json({ error: 'documentIds (non-empty array) and docType are required' });
  }

  try {
    const result = await query(
      `UPDATE documents SET doc_type = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::uuid[]) RETURNING id;`,
      [docType, documentIds]
    );
    return res.json({ updated: result.rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/documents/bulk/delete
router.post('/bulk/delete', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentIds } = req.body;
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return res.status(400).json({ error: 'documentIds (non-empty array) is required' });
  }

  try {
    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details)
       SELECT id, $2, 'bulk_delete', jsonb_build_object('title', title) FROM documents WHERE id = ANY($1::uuid[]);`,
      [documentIds, req.user?.id]
    );
    const result = await query(`DELETE FROM documents WHERE id = ANY($1::uuid[]) RETURNING id;`, [documentIds]);
    return res.json({ deleted: result.rows.length });
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

    let isEncrypted = false;
    let encryptionIv: string | null = null;
    let encryptionAuthTag: string | null = null;

    if (config.storageEncryptionEnabled) {
      const result = await encryptFile(tempPath, targetPath);
      encryptionIv = result.iv;
      encryptionAuthTag = result.authTag;
      isEncrypted = true;
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, targetPath);
    }

    const dbResult = await query(
      `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, created_by, is_encrypted, encryption_iv, encryption_auth_tag)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, $8, $9, $10)
       RETURNING *;`,
      [originalName, originalName, targetPath, req.file.size, mimeType, fileHash, req.user?.id, isEncrypted, encryptionIv, encryptionAuthTag]
    );

    const doc = dbResult.rows[0];

    // Audit log
    await query(`INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'upload', $3);`,
      [doc.id, req.user?.id, JSON.stringify({ filename: originalName, size: req.file.size })]
    );

    // Queue for OCR & AI
    await addDocumentProcessingJob(doc.id, targetPath);

    // Fire-and-forget: webhook delivery failures must never fail the upload response.
    dispatchWebhookEvent('document.created', { id: doc.id, title: doc.title, status: doc.status }).catch((err) =>
      console.error('Webhook dispatch failed for document.created:', err)
    );

    return res.status(201).json({ document: doc });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id/file (Download/Serve PDF file)
router.get('/:id/file', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const docRes = await query(`SELECT file_path, derived_file_path, original_filename, mime_type, is_encrypted, encryption_iv, encryption_auth_tag FROM documents WHERE id = $1;`, [id]);
    
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

    // Encryption-at-rest applies to the original file; derived files (e.g.
    // OCR-processed variants) are written back out in plaintext by the
    // worker today, so only decrypt when serving the original.
    if (doc.is_encrypted && servePath === doc.file_path && doc.encryption_iv && doc.encryption_auth_tag) {
      const decryptStream = createDecryptStream(doc.encryption_iv, doc.encryption_auth_tag);
      fs.createReadStream(servePath).pipe(decryptStream).pipe(res);
    } else {
      fs.createReadStream(servePath).pipe(res);
    }
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

// PUT /api/documents/:id/custom-fields (validate against the doc_type's schema, then save)
router.put('/:id/custom-fields', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { values } = req.body;

  if (!values || typeof values !== 'object') {
    return res.status(400).json({ error: 'values object is required' });
  }

  try {
    const docRes = await query(`SELECT * FROM documents WHERE id = $1;`, [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const doc = docRes.rows[0];

    const schemaRes = await query(`SELECT * FROM custom_fields WHERE doc_type = $1;`, [doc.doc_type]);
    const schema: CustomFieldDefinition[] = schemaRes.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      field_type: r.field_type,
      required: r.required,
      options: r.options,
    }));

    const validation = validateCustomFieldValues(schema, values);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }

    for (const field of schema) {
      const value = values[field.id];
      if (value === undefined) continue;

      const columns: Record<string, any> = { value_text: null, value_number: null, value_date: null, value_boolean: null };
      if (field.field_type === 'number') columns.value_number = value;
      else if (field.field_type === 'date') columns.value_date = value;
      else if (field.field_type === 'boolean') columns.value_boolean = value;
      else columns.value_text = String(value);

      await query(
        `INSERT INTO document_custom_fields (document_id, custom_field_id, value_text, value_number, value_date, value_boolean)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (document_id, custom_field_id)
         DO UPDATE SET value_text = $3, value_number = $4, value_date = $5, value_boolean = $6;`,
        [id, field.id, columns.value_text, columns.value_number, columns.value_date, columns.value_boolean]
      );
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
