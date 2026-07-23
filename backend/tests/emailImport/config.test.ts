import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';

describe('Email import configuration', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('PUT /api/email-import/config', () => {
    it('creates the config and never returns the password', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app)
        .put('/api/email-import/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ host: 'imap.example.com', port: 993, username: 'invoices@mydomain.com', password: 'super-secret' });

      expect(res.status).toBe(201);
      expect(res.body.config.password).toBeUndefined();
      expect(res.body.config.host).toBe('imap.example.com');
    });

    it('rejects non-admin users', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      const res = await request(app)
        .put('/api/email-import/config')
        .set('Authorization', `Bearer ${loginRes.body.token}`)
        .send({ host: 'imap.example.com', username: 'x', password: 'y' });

      expect(res.status).toBe(403);
    });

    it('rejects missing required fields', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app)
        .put('/api/email-import/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ host: 'imap.example.com' });

      expect(res.status).toBe(400);
    });

    it('replaces any existing config with the new one', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app)
        .put('/api/email-import/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ host: 'imap-old.example.com', username: 'old@mydomain.com', password: 'x' });

      await request(app)
        .put('/api/email-import/config')
        .set('Authorization', `Bearer ${token}`)
        .send({ host: 'imap-new.example.com', username: 'new@mydomain.com', password: 'y' });

      const getRes = await request(app).get('/api/email-import/config').set('Authorization', `Bearer ${token}`);
      expect(getRes.body.config.host).toBe('imap-new.example.com');
    });
  });

  describe('GET /api/email-import/config', () => {
    it('returns null when no config exists yet', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app).get('/api/email-import/config').set('Authorization', `Bearer ${token}`);
      expect(res.body.config).toBeNull();
    });
  });

  describe('POST /api/email-import/poll-now', () => {
    it('rejects when no active config exists', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app).post('/api/email-import/poll-now').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });
  });
});
