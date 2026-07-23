import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import pgvector from 'pgvector';
import axios from 'axios';

vi.mock('axios');

import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';
import { generateEmbedding } from '../../src/services/embedding.service';

describe('POST /api/chat/query', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    (axios.post as any) = vi.fn();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('returns an LLM-generated answer with structured citations (happy path, LLM call mocked)', async () => {
    const { token } = await loginAsAdmin(app);

    const doc = await createTestDocument({ title: 'Versicherungspolice 2025.pdf' });
    const chunkText = 'Die Versicherungsprämie für das Jahr 2025 betrug 450 EUR.';
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3);`,
      [doc.id, chunkText, pgvector.toSql(generateEmbedding(chunkText))]
    );

    // 1st axios.post call = query embedding (Ollama /api/embeddings) -- made
    // to fail so computeEmbedding falls back to the deterministic local
    // embedding (still functionally correct for this test, since the
    // fallback embedding is what was used to index the chunk above too).
    // 2nd axios.post call = the actual chat completion (Ollama /api/generate).
    (axios.post as any) = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ data: { response: 'Die Versicherungsprämie für 2025 betrug 450 EUR [1].' } });

    const res = await request(app)
      .post('/api/chat/query')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Wie viel habe ich 2025 für die Versicherung bezahlt?' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Die Versicherungsprämie für 2025 betrug 450 EUR [1].');
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({
      marker: '[1]',
      documentId: doc.id,
      chunkIndex: 0,
      documentTitle: 'Versicherungspolice 2025.pdf',
    });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('scopes retrieval to a tag when scope.tagId is provided', async () => {
    const { token } = await loginAsAdmin(app);

    const taggedDoc = await createTestDocument({ title: 'Tagged.pdf' });
    const otherDoc = await createTestDocument({ title: 'Other.pdf' });
    const tagRes = await query(`INSERT INTO tags (name) VALUES ('IntegrationTestTag') RETURNING id;`);
    const tagId = tagRes.rows[0].id;
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [taggedDoc.id, tagId]);

    const sharedText = 'Ein identischer Textausschnitt für den Vektorvergleich.';
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3);`,
      [taggedDoc.id, sharedText, pgvector.toSql(generateEmbedding(sharedText))]
    );
    await query(
      `INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3);`,
      [otherDoc.id, sharedText, pgvector.toSql(generateEmbedding(sharedText))]
    );

    (axios.post as any) = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ data: { response: 'Antwort ohne Zitat.' } });

    const res = await request(app)
      .post('/api/chat/query')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: sharedText, scope: { tagId } });

    expect(res.status).toBe(200);
    const generateCall = (axios.post as any).mock.calls.find((c: any[]) => c[0].includes('/api/generate'));
    expect(generateCall[1].prompt).toContain('Tagged.pdf');
    expect(generateCall[1].prompt).not.toContain('Other.pdf');
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/chat/query').send({ question: 'Test?' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when question is missing', async () => {
    const { token } = await loginAsAdmin(app);
    const res = await request(app)
      .post('/api/chat/query')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
