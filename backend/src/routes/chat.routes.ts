import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { answerQuestion } from '../services/ragChat.service';

const router = Router();

// POST /api/chat/query
// Body: { question: string, scope?: { tagId?: string; dateFrom?: string; dateTo?: string } }
//
// NOTE on visibility: this endpoint applies NO per-user document
// visibility filtering beyond `is_archived = FALSE`, matching the exact
// same uniform-visibility model as GET /api/search and GET /api/documents
// (neither of which filters by `created_by` / role today). This is a
// known gap tracked separately under ticket #19 (ACL); once #19 lands,
// this route's retrieval query will need the same per-user scoping
// applied there.
router.post('/query', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { question, scope } = req.body || {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const result = await answerQuestion(question.trim(), {
      tagId: scope?.tagId,
      dateFrom: scope?.dateFrom,
      dateTo: scope?.dateTo,
    });

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
