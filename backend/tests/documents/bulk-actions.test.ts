import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Bulk document actions', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/documents/bulk/tag', () => {
    it('adds a tag to every selected document', async () => {
      const { token } = await loginAsAdmin(app);
      const docA = await createTestDocument({ title: 'A.pdf' });
      const docB = await createTestDocument({ title: 'B.pdf' });
      const tagRes = await query(`INSERT INTO tags (name) VALUES ('BulkTagTest') RETURNING id;`);
      const tagId = tagRes.rows[0].id;

      const res = await request(app)
        .post('/api/documents/bulk/tag')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [docA.id, docB.id], tagId });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(2);

      const check = await query(`SELECT document_id FROM document_tags WHERE tag_id = $1;`, [tagId]);
      expect(check.rows.map((r: any) => r.document_id).sort()).toEqual([docA.id, docB.id].sort());
    });
  });

  describe('POST /api/documents/bulk/doc-type', () => {
    it('sets doc_type on every selected document', async () => {
      const { token } = await loginAsAdmin(app);
      const docA = await createTestDocument({ title: 'A.pdf' });
      const docB = await createTestDocument({ title: 'B.pdf' });

      const res = await request(app)
        .post('/api/documents/bulk/doc-type')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [docA.id, docB.id], docType: 'Rechnung' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(2);

      const check = await query(`SELECT doc_type FROM documents WHERE id = ANY($1::uuid[]);`, [[docA.id, docB.id]]);
      check.rows.forEach((r: any) => expect(r.doc_type).toBe('Rechnung'));
    });
  });

  describe('POST /api/documents/bulk/delete', () => {
    it('deletes every selected document and logs the action', async () => {
      const { token } = await loginAsAdmin(app);
      const docA = await createTestDocument({ title: 'A.pdf' });
      const docB = await createTestDocument({ title: 'B.pdf' });

      const res = await request(app)
        .post('/api/documents/bulk/delete')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [docA.id, docB.id] });

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(2);

      const check = await query(`SELECT id FROM documents WHERE id = ANY($1::uuid[]);`, [[docA.id, docB.id]]);
      expect(check.rows).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('rejects an empty documentIds array', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .post('/api/documents/bulk/doc-type')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [], docType: 'Rechnung' });

      expect(res.status).toBe(400);
    });
  });
});
