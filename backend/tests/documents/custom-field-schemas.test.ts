import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';

describe('Dynamic custom metadata schemas', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/custom-fields', () => {
    it('creates a custom field bound to a document type', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app)
        .post('/api/custom-fields')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung', required: true });

      expect(res.status).toBe(201);
      expect(res.body.custom_field).toMatchObject({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung', required: true });
    });

    it('rejects an unknown field_type', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .post('/api/custom-fields')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'X', field_type: 'not-a-real-type', doc_type: 'Rechnung' });

      expect(res.status).toBe(400);
    });

    it('rejects non-admin users', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      const res = await request(app)
        .post('/api/custom-fields')
        .set('Authorization', `Bearer ${loginRes.body.token}`)
        .send({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/custom-fields?doc_type=...', () => {
    it('returns only fields bound to the given document type', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app).post('/api/custom-fields').set('Authorization', `Bearer ${token}`).send({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung' });
      await request(app).post('/api/custom-fields').set('Authorization', `Bearer ${token}`).send({ name: 'Notice Period', field_type: 'string', doc_type: 'Vertrag' });

      const res = await request(app).get('/api/custom-fields').query({ doc_type: 'Rechnung' }).set('Authorization', `Bearer ${token}`);

      expect(res.body.custom_fields).toHaveLength(1);
      expect(res.body.custom_fields[0].name).toBe('IBAN');
    });
  });

  describe('PUT /api/documents/:id/custom-fields', () => {
    it('saves valid custom field values for the document', async () => {
      const { token } = await loginAsAdmin(app);
      const fieldRes = await request(app)
        .post('/api/custom-fields')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung', required: true });
      const fieldId = fieldRes.body.custom_field.id;

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await request(app).put(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${token}`).send({ doc_type: 'Rechnung' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/custom-fields`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: { [fieldId]: 'DE89370400440532013000' } });

      expect(res.status).toBe(200);

      const detailRes = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${token}`);
      expect(detailRes.body.custom_fields).toContainEqual(
        expect.objectContaining({ name: 'IBAN', value_text: 'DE89370400440532013000' })
      );
    });

    it('rejects saving when a required field for the document type is missing', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app)
        .post('/api/custom-fields')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'IBAN', field_type: 'string', doc_type: 'Rechnung', required: true });

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await request(app).put(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${token}`).send({ doc_type: 'Rechnung' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/custom-fields`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: {} });

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });
  });
});
