import { Router, Response } from 'express';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import {
  ReviewAction,
  ReviewActor,
  ReviewError,
  getReviewSettings,
  countOpenReviewItems,
  listReviewItems,
  resolveReviewItem,
  updateReviewSettings,
} from '../services/reviewInbox.service';
import { scanDocumentForSimilarity, scanPendingSimilarities } from '../services/duplicateDetection.service';

// Mounted at /api/review -- ticket #35, the review inbox.
const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorFrom(req: AuthRequest): ReviewActor {
  return { id: req.user!.id, role: req.user!.role, ip: req.ip };
}

function handleError(res: Response, err: any) {
  if (err instanceof ReviewError) {
    return res.status(err.status).json({ error: err.message, reason: err.reason, ...err.details });
  }
  return res.status(500).json({ error: err.message });
}

// GET /api/review?status=open|all&limit=100
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const status = req.query.status === 'all' ? 'all' : 'open';
    const items = await listReviewItems(actorFrom(req), { status, limit: Number(req.query.limit) || undefined });
    return res.json({ items, openCount: items.filter((item) => item.status === 'open').length });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// GET /api/review/count -- for the navigation badge.
router.get('/count', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ openCount: await countOpenReviewItems(actorFrom(req)) });
  } catch (err: any) {
    return handleError(res, err);
  }
});

/**
 * GET /api/review/settings
 *
 * Readable by every authenticated user: the thresholds explain why a
 * document is in the inbox, and a reviewer who cannot see them is guessing
 * at the system's reasoning. Changing them stays with administrators.
 */
router.get('/settings', authenticateToken, async (_req: AuthRequest, res: Response) => {
  try {
    return res.json({ settings: await getReviewSettings() });
  } catch (err: any) {
    return handleError(res, err);
  }
});

// PUT /api/review/settings { autoAcceptConfidence?, reviewConfidence?, duplicateSimilarity?, similarityScanCandidates? }
router.put('/settings', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    return res.json({ settings: await updateReviewSettings(actorFrom(req), req.body ?? {}) });
  } catch (err: any) {
    return handleError(res, err);
  }
});

/**
 * POST /api/review/scan
 *
 * Runs the pending similarity comparisons now instead of waiting for the
 * scheduler. Admin-only because it reads across the whole archive; the
 * candidates it records are still only ever candidates.
 */
router.post('/scan', authenticateToken, requireRole(['admin']), async (req: AuthRequest, res: Response) => {
  try {
    const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId : undefined;
    if (documentId) {
      if (!UUID_PATTERN.test(documentId)) {
        return res.status(400).json({ error: 'Invalid document id', reason: 'invalid_document_id' });
      }
      return res.json({ results: [await scanDocumentForSimilarity(documentId)] });
    }
    return res.json({ results: await scanPendingSimilarities(Number(req.body?.limit) || undefined) });
  } catch (err: any) {
    return handleError(res, err);
  }
});

const ACTIONS: ReviewAction[] = ['accept', 'correct', 'retry', 'separate', 'dismiss'];

for (const action of ACTIONS) {
  router.post(`/:id/${action}`, authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
      if (!UUID_PATTERN.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid review item id', reason: 'invalid_review_item_id' });
      }
      const resolution = await resolveReviewItem(actorFrom(req), req.params.id, action, {
        values: req.body?.values,
        note: req.body?.note,
      });
      return res.json(resolution);
    } catch (err: any) {
      return handleError(res, err);
    }
  });
}

export default router;
