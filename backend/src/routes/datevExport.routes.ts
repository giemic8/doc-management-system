import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { query } from '../database/db';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { buildDatevExportZip, DatevExportDocument } from '../services/datevExport.service';

// Mounted at /api/export -- DATEV & tax advisor export package.
export const datevExportRouter = Router();

// GET /api/export/datev?start_date=...&end_date=... (admin: DATEV CSV + PDFs ZIP)
datevExportRouter.get('/datev', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  const { start_date, end_date } = req.query;

  try {
    let docsQuery = `SELECT id, file_path, original_filename, document_date, amount, currency, tax_id, sender, is_encrypted, encryption_iv, encryption_auth_tag FROM documents WHERE 1=1`;
    const params: any[] = [];
    if (start_date) {
      params.push(start_date);
      docsQuery += ` AND document_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      docsQuery += ` AND document_date <= $${params.length}`;
    }

    const docsRes = await query(docsQuery, params);
    const documents: DatevExportDocument[] = docsRes.rows;

    const zipPath = path.join(os.tmpdir(), `datev-export-${Date.now()}.zip`);
    await buildDatevExportZip(zipPath, documents);

    res.download(zipPath, 'datev-export.zip', (err) => {
      // Clean up the temp file regardless of whether the download succeeded.
      fs.unlink(zipPath, () => {});
      if (err) console.error('DATEV export download error:', err);
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
