import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('DATEV & tax advisor export package', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET /api/export/datev', () => {
    it('returns a ZIP file for admin users covering documents in the date range', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await query(
        `UPDATE documents SET document_date = '2024-05-10', amount = 1499, sender = 'Dell Technologies GmbH', tax_id = 'DE123456789' WHERE id = $1;`,
        [doc.id]
      );

      const res = await request(app)
        .get('/api/export/datev')
        .query({ start_date: '2024-01-01', end_date: '2024-12-31' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
    });

    it('rejects non-admin users', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/export/datev')
        .query({ start_date: '2024-01-01', end_date: '2024-12-31' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns a valid (empty) ZIP for a date range with no matching documents', async () => {
      const { token } = await loginAsAdmin(app);
      await createTestDocument({ title: 'OutOfRange.pdf' });

      const res = await request(app)
        .get('/api/export/datev')
        .query({ start_date: '2099-01-01', end_date: '2099-12-31' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
    });
  });
});
