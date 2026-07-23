import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Contract expiration watcher & cancellation letters', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET /api/contracts', () => {
    it('returns 200 with a list of contract-type documents', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Mietvertrag.pdf' });
      await query(`UPDATE documents SET doc_type = 'Vertrag', sender = 'Hausverwaltung GmbH' WHERE id = $1;`, [doc.id]);

      const res = await request(app).get('/api/contracts').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.contracts)).toBe(true);
      expect(res.body.contracts.some((c: any) => c.document_id === doc.id)).toBe(true);
      const contract = res.body.contracts.find((c: any) => c.document_id === doc.id);
      expect(contract.status).toBe('active');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/contracts');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/contracts/:documentId/details', () => {
    it('persists contract details and reflects them in a subsequent GET', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Vertrag.pdf' });
      await query(`UPDATE documents SET doc_type = 'Vertrag', sender = 'Vendor AG' WHERE id = $1;`, [doc.id]);

      const putRes = await request(app)
        .put(`/api/contracts/${doc.id}/details`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          customer_number: 'CU-9988',
          vendor_address: 'Vendorstraße 5\n80331 München',
          notice_period_days: 14,
          contract_end_date: '2026-12-31',
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.contract_details.customer_number).toBe('CU-9988');
      expect(putRes.body.contract_details.cancellation_deadline).toBeTruthy();

      const getRes = await request(app).get('/api/contracts').set('Authorization', `Bearer ${token}`);
      const contract = getRes.body.contracts.find((c: any) => c.document_id === doc.id);
      expect(contract.customer_number).toBe('CU-9988');
      expect(contract.notice_period_days).toBe(14);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).put('/api/contracts/00000000-0000-0000-0000-000000000000/details').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/contracts/:documentId/cancellation-letter', () => {
    it('returns a PDF cancellation letter', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Vertrag.pdf' });
      await query(`UPDATE documents SET doc_type = 'Vertrag', sender = 'Vendor AG' WHERE id = $1;`, [doc.id]);

      await request(app)
        .put(`/api/contracts/${doc.id}/details`)
        .set('Authorization', `Bearer ${token}`)
        .send({ customer_number: 'CU-1', vendor_address: 'Street 1', notice_period_days: 30, contract_end_date: '2026-12-31' });

      const res = await request(app)
        .get(`/api/contracts/${doc.id}/cancellation-letter`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      const body: Buffer = res.body;
      expect(Buffer.isBuffer(body)).toBe(true);
      expect(body.subarray(0, 4).toString('utf-8')).toBe('%PDF');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/contracts/00000000-0000-0000-0000-000000000000/cancellation-letter');
      expect(res.status).toBe(401);
    });
  });
});
