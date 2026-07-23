import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument, makeTestPdfFile } from '../helpers/documents';

describe('PDF split & merge', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/documents/:id/split', () => {
    it('splits a document into two new document records at the given page', async () => {
      const { token } = await loginAsAdmin(app);
      const { filePath } = await makeTestPdfFile(4);
      const doc = await createTestDocument({ filePath, title: 'Multi-page scan.pdf' });

      const res = await request(app)
        .post(`/api/documents/${doc.id}/split`)
        .set('Authorization', `Bearer ${token}`)
        .send({ splitAtPage: 2 });

      expect(res.status).toBe(200);
      expect(res.body.documents).toHaveLength(2);

      const [firstDoc, secondDoc] = res.body.documents;
      expect(firstDoc.id).not.toBe(secondDoc.id);

      const firstPdf = await PDFDocument.load(require('fs').readFileSync(firstDoc.file_path));
      const secondPdf = await PDFDocument.load(require('fs').readFileSync(secondDoc.file_path));
      expect(firstPdf.getPageCount()).toBe(2);
      expect(secondPdf.getPageCount()).toBe(2);
    });

    it('preserves the original file hash in an audit log entry', async () => {
      const { token } = await loginAsAdmin(app);
      const { filePath } = await makeTestPdfFile(3);
      const doc = await createTestDocument({ filePath });

      const splitRes = await request(app)
        .post(`/api/documents/${doc.id}/split`)
        .set('Authorization', `Bearer ${token}`)
        .send({ splitAtPage: 1 });

      const { query } = await import('../../src/database/db');
      const newDocIds = splitRes.body.documents.map((d: any) => d.id);
      const auditRes = await query(`SELECT * FROM audit_logs WHERE document_id = ANY($1::uuid[]) AND action = 'split';`, [newDocIds]);
      expect(auditRes.rows).toHaveLength(2);
      auditRes.rows.forEach((row: any) => {
        expect(row.details.original_file_hash).toBe(doc.file_hash);
        expect(row.details.source_document_id).toBe(doc.id);
      });
    });

    it('rejects an out-of-range split point', async () => {
      const { token } = await loginAsAdmin(app);
      const { filePath } = await makeTestPdfFile(2);
      const doc = await createTestDocument({ filePath });

      const res = await request(app)
        .post(`/api/documents/${doc.id}/split`)
        .set('Authorization', `Bearer ${token}`)
        .send({ splitAtPage: 5 });

      expect(res.status).toBe(400);
    });

    it('404s for an unknown document', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .post('/api/documents/00000000-0000-0000-0000-000000000000/split')
        .set('Authorization', `Bearer ${token}`)
        .send({ splitAtPage: 1 });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/documents/merge', () => {
    it('merges multiple documents into a new single document record', async () => {
      const { token } = await loginAsAdmin(app);
      const { filePath: pathA } = await makeTestPdfFile(2);
      const { filePath: pathB } = await makeTestPdfFile(3);
      const docA = await createTestDocument({ filePath: pathA, title: 'Receipt A.pdf' });
      const docB = await createTestDocument({ filePath: pathB, title: 'Receipt B.pdf' });

      const res = await request(app)
        .post('/api/documents/merge')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [docA.id, docB.id] });

      expect(res.status).toBe(200);
      expect(res.body.document).toBeDefined();

      const mergedPdf = await PDFDocument.load(require('fs').readFileSync(res.body.document.file_path));
      expect(mergedPdf.getPageCount()).toBe(5);
    });

    it('rejects merging fewer than two documents', async () => {
      const { token } = await loginAsAdmin(app);
      const { filePath } = await makeTestPdfFile(2);
      const doc = await createTestDocument({ filePath });

      const res = await request(app)
        .post('/api/documents/merge')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [doc.id] });

      expect(res.status).toBe(400);
    });
  });
});
