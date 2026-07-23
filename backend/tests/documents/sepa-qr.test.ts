import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('SEPA EPC-QR code generation', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET /api/documents/:id/sepa-qr', () => {
    it('generates a QR code from the document\'s extracted invoice metadata', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await query(
        `UPDATE documents SET sender = $1, amount = $2, doc_type = 'Rechnung' WHERE id = $3;`,
        ['Dell Technologies GmbH', 1499.0, doc.id]
      );

      const res = await request(app)
        .get(`/api/documents/${doc.id}/sepa-qr`)
        .query({ iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(res.body.payload).toContain('Dell Technologies GmbH');
      expect(res.body.payload).toContain('EUR1499.00');
    });

    it('allows overriding the amount via query params (manual correction)', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await query(`UPDATE documents SET sender = 'X', amount = 100 WHERE id = $1;`, [doc.id]);

      const res = await request(app)
        .get(`/api/documents/${doc.id}/sepa-qr`)
        .query({ iban: 'DE89370400440532013000', amount: '250.50' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.payload).toContain('EUR250.50');
    });

    it('rejects when no IBAN is available (not extracted, not provided)', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await query(`UPDATE documents SET sender = 'X', amount = 100 WHERE id = $1;`, [doc.id]);

      const res = await request(app).get(`/api/documents/${doc.id}/sepa-qr`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('404s for an unknown document', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .get('/api/documents/00000000-0000-0000-0000-000000000000/sepa-qr')
        .query({ iban: 'DE89370400440532013000' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
