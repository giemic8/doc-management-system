import { Router, Response } from 'express';
import pgvector from 'pgvector';
import { query } from '../database/db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { generateEmbedding } from '../services/embedding.service';
import { reciprocalRankFusion } from '../services/hybridSearch.service';

const router = Router();

// GET /api/search?q=... (hybrid keyword + vector search with RRF)
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
  const q = (req.query.q as string) || '';
  if (!q.trim()) {
    return res.status(400).json({ error: 'q query parameter is required' });
  }

  try {
    // Leg 1: keyword full-text search over title/ocr_text/sender/summary.
    const keywordRes = await query(
      `SELECT id FROM documents
       WHERE is_archived = FALSE
         AND (title ILIKE $1 OR ocr_text ILIKE $1 OR sender ILIKE $1 OR summary ILIKE $1)
       ORDER BY created_at DESC
       LIMIT 20;`,
      [`%${q}%`]
    );
    const keywordIds: string[] = keywordRes.rows.map((r: any) => r.id);

    // Leg 2: vector cosine-similarity search over document_chunks.
    const queryEmbedding = generateEmbedding(q);
    const vectorRes = await query(
      `SELECT DISTINCT ON (document_id) document_id, embedding <=> $1 AS distance
       FROM document_chunks
       ORDER BY document_id, distance ASC
       LIMIT 200;`,
      [pgvector.toSql(queryEmbedding)]
    );
    // Re-sort by distance ascending (closest first) across all documents,
    // since the DISTINCT ON above only guarantees per-document ordering.
    const vectorIds: string[] = vectorRes.rows
      .sort((a: any, b: any) => a.distance - b.distance)
      .slice(0, 20)
      .map((r: any) => r.document_id);

    const fused = reciprocalRankFusion([keywordIds, vectorIds]);
    if (fused.length === 0) {
      return res.json({ results: [] });
    }

    const ids = fused.map((f) => f.id);
    const docsRes = await query(`SELECT * FROM documents WHERE id = ANY($1::uuid[]);`, [ids]);
    const docsById = new Map(docsRes.rows.map((d: any) => [d.id, d]));

    const results = fused
      .filter((f) => docsById.has(f.id))
      .map((f) => ({ ...docsById.get(f.id), score: f.score }));

    return res.json({ results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
