import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { deriveContractStatus } from '../services/contractWatcher.service';
import { buildCancellationLetterPdf } from '../services/cancellationLetter.service';

const router = Router();

// Doc types treated as "contracts" for the dashboard. Matches the seeded
// 'Vertrag' tag/doc_type convention used elsewhere in the app.
const CONTRACT_DOC_TYPES = ['Vertrag'];

// GET /api/contracts — list documents that look like contracts, joined
// with their contract_details (if any), with a derived status.
// Optional ?status=active|notice_deadline_nearing|expired filter.
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT d.id AS document_id, d.title, d.sender, d.document_date, d.due_date,
              cd.customer_number, cd.vendor_address, cd.notice_period_days,
              cd.cancellation_deadline, cd.contract_end_date, cd.alert_sent_at
       FROM documents d
       LEFT JOIN contract_details cd ON cd.document_id = d.id
       WHERE d.doc_type = ANY($1::text[])
       ORDER BY d.created_at DESC;`,
      [CONTRACT_DOC_TYPES]
    );

    let contracts = result.rows.map((row: any) => ({
      ...row,
      status: deriveContractStatus(row.cancellation_deadline),
    }));

    const { status } = req.query;
    if (status && typeof status === 'string') {
      contracts = contracts.filter((c: any) => c.status === status);
    }

    return res.json({ contracts });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/contracts/:documentId/details — upsert contract_details for a document.
router.put('/:documentId/details', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentId } = req.params;
  const { customer_number, vendor_address, notice_period_days, contract_end_date } = req.body;

  try {
    const docRes = await query(`SELECT id FROM documents WHERE id = $1;`, [documentId]);
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const effectiveNoticePeriodDays = notice_period_days ?? 30;
    let cancellationDeadline: string | null = null;
    if (contract_end_date) {
      const endDate = new Date(contract_end_date);
      const deadline = new Date(endDate);
      deadline.setDate(deadline.getDate() - Number(effectiveNoticePeriodDays));
      cancellationDeadline = deadline.toISOString().slice(0, 10);
    }

    const result = await query(
      `INSERT INTO contract_details (document_id, customer_number, vendor_address, notice_period_days, contract_end_date, cancellation_deadline)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id) DO UPDATE SET
         customer_number = EXCLUDED.customer_number,
         vendor_address = EXCLUDED.vendor_address,
         notice_period_days = EXCLUDED.notice_period_days,
         contract_end_date = EXCLUDED.contract_end_date,
         cancellation_deadline = EXCLUDED.cancellation_deadline
       RETURNING *;`,
      [documentId, customer_number ?? null, vendor_address ?? null, effectiveNoticePeriodDays, contract_end_date ?? null, cancellationDeadline]
    );

    return res.json({ contract_details: result.rows[0] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/contracts/:documentId/cancellation-letter — generates a 1-click
// formal cancellation letter PDF for the given contract document.
router.get('/:documentId/cancellation-letter', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { documentId } = req.params;

  try {
    const result = await query(
      `SELECT d.title, d.sender,
              cd.customer_number, cd.vendor_address, cd.cancellation_deadline
       FROM documents d
       LEFT JOIN contract_details cd ON cd.document_id = d.id
       WHERE d.id = $1;`,
      [documentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const row = result.rows[0];
    const pdfBuffer = await buildCancellationLetterPdf({
      vendorName: row.sender || 'Unbekannter Vertragspartner',
      vendorAddress: row.vendor_address || undefined,
      customerNumber: row.customer_number || undefined,
      contractTitle: row.title,
      cancellationDeadline: row.cancellation_deadline || undefined,
      senderName: req.user?.name,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="kuendigung.pdf"');
    return res.send(pdfBuffer);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
