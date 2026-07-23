import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('GoBD retention policy & audit export', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('PUT /api/documents/:id/retention', () => {
    it('sets a retention lock N years in the future', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/retention`)
        .set('Authorization', `Bearer ${token}`)
        .send({ retentionYears: 10 });

      expect(res.status).toBe(200);
      const retentionUntil = new Date(res.body.document.retention_until);
      expect(retentionUntil.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 10);
    });

    it('toggles legal hold independently of retention', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Contract.pdf' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/retention`)
        .set('Authorization', `Bearer ${token}`)
        .send({ legalHold: true });

      expect(res.status).toBe(200);
      expect(res.body.document.legal_hold).toBe(true);
    });
  });

  describe('retention enforcement', () => {
    it('prevents deleting a document under an active retention lock', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await request(app).put(`/api/documents/${doc.id}/retention`).set('Authorization', `Bearer ${token}`).send({ retentionYears: 10 });

      const res = await request(app)
        .post('/api/documents/bulk/delete')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [doc.id] });

      expect(res.status).toBe(423);

      const check = await query(`SELECT id FROM documents WHERE id = $1;`, [doc.id]);
      expect(check.rows).toHaveLength(1);
    });

    it('prevents modifying a document under legal hold', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      await request(app).put(`/api/documents/${doc.id}/retention`).set('Authorization', `Bearer ${token}`).send({ legalHold: true });

      const res = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed.pdf' });

      expect(res.status).toBe(423);
    });

    it('allows deleting a document once its retention period has expired', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Old.pdf' });
      // Set retention to a date in the past directly (retentionYears: 0 with
      // a manual backdate isn't exposed via the API, so seed it directly).
      await query(`UPDATE documents SET retention_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = $1;`, [doc.id]);

      const res = await request(app)
        .post('/api/documents/bulk/delete')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [doc.id] });

      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/export/audit-package', () => {
    it('returns a ZIP file for admin users', async () => {
      const { token } = await loginAsAdmin(app);
      await createTestDocument({ title: 'Invoice.pdf' });

      const res = await request(app).get('/api/export/audit-package').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
    });
  });
});
