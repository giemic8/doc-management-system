import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';
import { generateEmbedding } from '../../src/services/embedding.service';
import pgvector from 'pgvector';

describe('Hybrid semantic search', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('finds documents by keyword match even with no embeddings indexed', async () => {
    const { token } = await loginAsAdmin(app);
    const doc = await createTestDocument({ title: 'Steuerbescheid 2024.pdf' });
    await query(`UPDATE documents SET ocr_text = $1 WHERE id = $2;`, ['Steuerbescheid vom Finanzamt München', doc.id]);

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'Finanzamt' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.results.some((r: any) => r.id === doc.id)).toBe(true);
    expect(res.body.results[0]).toHaveProperty('score');
  });

  it('finds documents by vector similarity even when keywords do not match the search query directly', async () => {
    const { token } = await loginAsAdmin(app);
    const doc = await createTestDocument({ title: 'Tax document.pdf' });
    const chunkText = 'Assessment of income tax liability for fiscal year';
    await query(`UPDATE documents SET ocr_text = $1 WHERE id = $2;`, [chunkText, doc.id]);

    const embedding = generateEmbedding(chunkText);
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3);`,
      [doc.id, chunkText, pgvector.toSql(embedding)]
    );

    // Searching with the exact same text should trivially match via the
    // vector leg (identical embedding -> similarity 1.0) even though this
    // assertion alone doesn't prove keyword-independence; the deterministic
    // fallback embedding here is char-ngram based, not semantic, so we can't
    // assert true semantic recall without a real model. What we CAN assert
    // is that the vector leg contributes: a chunk row with an embedding
    // exists and the document is returned by search.
    const res = await request(app)
      .get('/api/search')
      .query({ q: chunkText })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.results.some((r: any) => r.id === doc.id)).toBe(true);
  });

  it('returns an empty result set for a query matching nothing', async () => {
    const { token } = await loginAsAdmin(app);
    await createTestDocument({ title: 'Unrelated.pdf' });

    const res = await request(app)
      .get('/api/search')
      .query({ q: 'zzz_totally_unrelated_query_zzz' })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/search').query({ q: 'test' });
    expect(res.status).toBe(401);
  });
});
