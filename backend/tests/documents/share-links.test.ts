import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Guest share links (Ticket #16)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/documents/:id/share-links', () => {
    it('requires authentication', async () => {
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      const res = await request(app).post(`/api/documents/${doc.id}/share-links`).send({});
      expect(res.status).toBe(401);
    });

    it('creates a share link and returns a token', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Contract.pdf' });

      const res = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'guestpass123', expiresInDays: 7, maxDownloads: 3 });

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.shareUrl).toBe(`/share/${res.body.token}`);
      expect(res.body.maxDownloads).toBe(3);
      expect(res.body.expiresAt).toBeTruthy();

      const dbRow = await query(`SELECT password_hash, token FROM document_share_links WHERE token = $1;`, [
        res.body.token,
      ]);
      expect(dbRow.rows[0].password_hash).not.toBe('guestpass123');
      expect(dbRow.rows[0].password_hash).not.toBeNull();
    });
  });

  describe('GET /api/documents/:id/share-links', () => {
    it('requires authentication', async () => {
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      const res = await request(app).get(`/api/documents/${doc.id}/share-links`);
      expect(res.status).toBe(401);
    });

    it('lists active links without exposing password_hash or the raw token', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      const res = await request(app)
        .get(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.shareLinks).toHaveLength(1);
      expect(res.body.shareLinks[0]).not.toHaveProperty('password_hash');
      expect(res.body.shareLinks[0]).not.toHaveProperty('token');
    });
  });

  describe('DELETE /api/documents/:id/share-links/:linkId', () => {
    it('requires authentication', async () => {
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      const res = await request(app).delete(`/api/documents/${doc.id}/share-links/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(401);
    });

    it('revokes a link, making it immediately inaccessible', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Contract.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});
      const shareToken = createRes.body.token;

      const linkRow = await query(`SELECT id FROM document_share_links WHERE token = $1;`, [shareToken]);
      const linkId = linkRow.rows[0].id;

      const delRes = await request(app)
        .delete(`/api/documents/${doc.id}/share-links/${linkId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(delRes.status).toBe(200);

      const infoRes = await request(app).get(`/api/share/${shareToken}/info`);
      expect(infoRes.body.valid).toBe(false);
      expect(infoRes.body.reason).toBe('revoked');
    });
  });

  describe('Public GET /api/share/:token/info', () => {
    it('returns document title and password requirement for a valid link', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Bank Statement.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ password: 'secret123' });

      const infoRes = await request(app).get(`/api/share/${createRes.body.token}/info`);
      expect(infoRes.status).toBe(200);
      expect(infoRes.body.documentTitle).toBe('Bank Statement.pdf');
      expect(infoRes.body.requiresPassword).toBe(true);
      expect(infoRes.body.valid).toBe(true);
    });

    it('404s for an unknown token', async () => {
      const res = await request(app).get(`/api/share/${'0'.repeat(64)}/info`);
      expect(res.status).toBe(404);
    });
  });

  describe('Public GET /api/share/:token/download', () => {
    it('downloads with the correct password and increments download_count', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ password: 'correct-pw', maxDownloads: 5 });
      const shareToken = createRes.body.token;

      const downloadRes = await request(app)
        .get(`/api/share/${shareToken}/download`)
        .query({ password: 'correct-pw' });

      expect(downloadRes.status).toBe(200);

      const row = await query(`SELECT download_count FROM document_share_links WHERE token = $1;`, [shareToken]);
      expect(row.rows[0].download_count).toBe(1);

      const auditRes = await query(
        `SELECT action, details FROM audit_logs WHERE document_id = $1 AND action = 'guest_share_access';`,
        [doc.id]
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(auditRes.rows[0].details.shareLinkId).toBeTruthy();
      // Never leak the raw token into the audit log.
      expect(JSON.stringify(auditRes.rows[0].details)).not.toContain(shareToken);
    });

    it('rejects a wrong password and does not increment download_count', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ password: 'correct-pw' });
      const shareToken = createRes.body.token;

      const downloadRes = await request(app)
        .get(`/api/share/${shareToken}/download`)
        .query({ password: 'wrong-pw' });

      expect(downloadRes.status).toBe(403);

      const row = await query(`SELECT download_count FROM document_share_links WHERE token = $1;`, [shareToken]);
      expect(row.rows[0].download_count).toBe(0);

      const auditRes = await query(
        `SELECT action FROM audit_logs WHERE document_id = $1 AND action = 'guest_share_password_fail';`,
        [doc.id]
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects further downloads once maxDownloads is reached, even with the correct password', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ maxDownloads: 1 });
      const shareToken = createRes.body.token;

      const first = await request(app).get(`/api/share/${shareToken}/download`);
      expect(first.status).toBe(200);

      const second = await request(app).get(`/api/share/${shareToken}/download`);
      expect(second.status).toBe(403);
      expect(second.body.reason).toBe('limit_exceeded');
    });

    it('rejects an expired link with 410, without serving the file, regardless of a correct password', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ password: 'correct-pw' });
      const shareToken = createRes.body.token;

      await query(
        `UPDATE document_share_links SET expires_at = NOW() - INTERVAL '1 day' WHERE token = $1;`,
        [shareToken]
      );

      const res = await request(app).get(`/api/share/${shareToken}/download`).query({ password: 'correct-pw' });
      expect(res.status).toBe(410);
      expect(res.body.reason).toBe('expired');
    });

    it('serves without a password when the link has none configured', async () => {
      const { token: authToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Public.pdf' });
      const createRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({});
      const shareToken = createRes.body.token;

      const res = await request(app).get(`/api/share/${shareToken}/download`);
      expect(res.status).toBe(200);
    });

    it('404s for an unknown token', async () => {
      const res = await request(app).get(`/api/share/${'0'.repeat(64)}/download`);
      expect(res.status).toBe(404);
    });
  });
});
