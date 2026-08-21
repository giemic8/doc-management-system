import { Router, Response } from 'express';
import { query } from '../database/db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import {
  buildMonthlyBreakdown,
  buildTopVendors,
  detectRecurringSubscriptions,
  AnalyticsDoc,
} from '../services/analytics.service';
import { buildDocumentAclWhereClause } from '../services/acl.service';

const router = Router();

// GET /api/analytics/summary?start_date=&end_date=&tagId=&currency=
router.get('/summary', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { start_date, end_date, tagId, currency } = req.query as {
      start_date?: string;
      end_date?: string;
      tagId?: string;
      currency?: string;
    };

    let queryText = `
      SELECT DISTINCT d.id, d.sender, d.document_date, d.amount, d.currency
      FROM documents d
    `;
    const params: any[] = [];

    if (tagId) {
      queryText += ` JOIN document_tags dt ON dt.document_id = d.id AND dt.tag_id = $${params.length + 1}`;
      params.push(tagId);
    }

    queryText += ` WHERE d.is_archived = FALSE`;

    if (start_date) {
      params.push(start_date);
      queryText += ` AND d.document_date >= $${params.length}`;
    }

    if (end_date) {
      params.push(end_date);
      queryText += ` AND d.document_date <= $${params.length}`;
    }

    if (currency) {
      params.push(currency);
      queryText += ` AND d.currency = $${params.length}`;
    }

    const aclClause = buildDocumentAclWhereClause({ userId: req.user!.id, role: req.user!.role }, params);
    if (aclClause) {
      queryText += ` AND ${aclClause}`;
    }

    const result = await query(queryText, params);
    const documents: AnalyticsDoc[] = result.rows;

    const monthlyBreakdown = buildMonthlyBreakdown(documents);
    const topVendors = buildTopVendors(documents);
    const recurringSubscriptions = detectRecurringSubscriptions(documents);

    return res.json({ monthlyBreakdown, topVendors, recurringSubscriptions });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
