import { Router, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { answerQuestion } from '../services/ragChat.service';

const router = Router();

// POST /api/chat/query
// Body: { question: string, scope?: { tagId?: string; dateFrom?: string; dateTo?: string } }
//
// Ticket #19 -- Granular Tag ACLs: retrieval is scoped by the requesting
// user's group tag permissions (see acl.service.ts / ragChat.service.ts's
// retrieveRelevantChunks), matching the same visibility rule already
// applied to GET /api/documents and GET /api/search. Admins bypass this
// entirely; if no ACLs are configured yet, every document remains
// visible (backward compatible with the pre-#19 uniform-visibility
// model this endpoint originally shipped with).
router.post('/query', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { question, scope } = req.body || {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const result = await answerQuestion(
      question.trim(),
      {
        tagId: scope?.tagId,
        dateFrom: scope?.dateFrom,
        dateTo: scope?.dateTo,
      },
      undefined,
      undefined,
      { userId: req.user!.id, role: req.user!.role }
    );

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
