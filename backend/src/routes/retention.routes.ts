import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { calculateRetentionExpiry } from '../services/retention.service';
import { buildAuditExportZip } from '../services/auditExport.service';

// Mounted at /api/documents -- adds a :id/retention route alongside the
// rest of the document routes.
export const documentRetentionRouter = Router();

// PUT /api/documents/:id/retention (admin: set a retention lock in years, or toggle legal hold)
documentRetentionRouter.put('/:id/retention', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { retentionYears, legalHold } = req.body;

  try {
    const docRes = await query(`SELECT * FROM documents WHERE id = $1;`, [id]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (retentionYears !== undefined) {
      const retentionUntil = retentionYears === null ? null : calculateRetentionExpiry(new Date(), retentionYears);
      params.push(retentionUntil);
      updates.push(`retention_until = $${params.length}`);
    }
    if (legalHold !== undefined) {
      params.push(legalHold);
      updates.push(`legal_hold = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'retentionYears or legalHold is required' });
    }

    params.push(id);
    const result = await query(
      `UPDATE documents SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id, retention_until, legal_hold;`,
      params
    );

    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'retention_update', $3);`,
      [id, req.user?.id, JSON.stringify({ retentionYears, legalHold })]
    );

    return res.json({ document: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Mounted at /api/export -- separate top-level export namespace.
export const auditExportRouter = Router();

// GET /api/export/audit-package?start_date=...&end_date=... (admin: GoBD-style export ZIP)
auditExportRouter.get('/audit-package', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { start_date, end_date } = req.query;

  try {
    let docsQuery = `SELECT id, file_path, original_filename, file_hash FROM documents WHERE 1=1`;
    const params: any[] = [];
    if (start_date) {
      params.push(start_date);
      docsQuery += ` AND created_at >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      docsQuery += ` AND created_at <= $${params.length}`;
    }

    const docsRes = await query(docsQuery, params);
    const documentIds = docsRes.rows.map((d: any) => d.id);

    const auditRes = documentIds.length
      ? await query(`SELECT * FROM audit_logs WHERE document_id = ANY($1::uuid[]) ORDER BY created_at ASC;`, [documentIds])
      : { rows: [] };

    const zipPath = path.join(os.tmpdir(), `audit-export-${Date.now()}.zip`);
    await buildAuditExportZip(zipPath, docsRes.rows, auditRes.rows);

    res.download(zipPath, 'audit-export.zip', (err) => {
      // Clean up the temp file regardless of whether the download succeeded.
      fs.unlink(zipPath, () => {});
      if (err) console.error('Audit export download error:', err);
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
