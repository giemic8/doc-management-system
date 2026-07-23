import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';

describe('Webhook endpoint management', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/webhooks', () => {
    it('creates a webhook endpoint and returns the signing secret once', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['document.created', 'workflow.triggered'] });

      expect(res.status).toBe(201);
      expect(res.body.webhook.secret).toMatch(/^whsec_[a-f0-9]{48}$/);
      expect(res.body.webhook.events).toEqual(['document.created', 'workflow.triggered']);
    });

    it('rejects invalid event names', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['not.a.real.event'] });

      expect(res.status).toBe(400);
    });

    it('rejects non-admin users', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      const res = await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${loginRes.body.token}`)
        .send({ url: 'https://example.com/hook', events: ['document.created'] });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/webhooks', () => {
    it('lists webhooks without exposing the secret', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['document.created'] });

      const res = await request(app).get('/api/webhooks').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.webhooks).toHaveLength(1);
      expect(res.body.webhooks[0].secret).toBeUndefined();
    });
  });

  describe('PUT /api/webhooks/:id', () => {
    it('updates the active state', async () => {
      const { token } = await loginAsAdmin(app);
      const createRes = await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['document.created'] });

      const res = await request(app)
        .put(`/api/webhooks/${createRes.body.webhook.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ is_active: false });

      expect(res.status).toBe(200);
      expect(res.body.webhook.is_active).toBe(false);
    });
  });

  describe('DELETE /api/webhooks/:id', () => {
    it('removes the endpoint', async () => {
      const { token } = await loginAsAdmin(app);
      const createRes = await request(app)
        .post('/api/webhooks')
        .set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/hook', events: ['document.created'] });

      const deleteRes = await request(app)
        .delete(`/api/webhooks/${createRes.body.webhook.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deleteRes.status).toBe(200);

      const listRes = await request(app).get('/api/webhooks').set('Authorization', `Bearer ${token}`);
      expect(listRes.body.webhooks).toHaveLength(0);
    });
  });
});
