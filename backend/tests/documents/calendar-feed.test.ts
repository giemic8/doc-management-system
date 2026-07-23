import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Calendar feed (iCal/ICS subscription)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/calendar/feed-token', () => {
    it('generates a feed token for the authenticated user and returns a feedUrl', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app).post('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
      expect(res.body.feedUrl).toMatch(/^\/api\/calendar\/feed\.ics\?token=[a-f0-9]{64}$/);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).post('/api/calendar/feed-token');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/calendar/feed-token', () => {
    it('reports hasToken: false before any token is generated', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app).get('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hasToken: false });
    });

    it('reports hasToken: true after generating a token, without exposing the raw value', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app).post('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);

      const res = await request(app).get('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hasToken: true });
    });
  });

  describe('GET /api/calendar/feed.ics', () => {
    it('returns a valid ICS calendar feed for a valid token', async () => {
      const { token, user } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf', createdBy: user.id });
      await query(
        `UPDATE documents SET sender = $1, amount = $2, doc_type = 'Rechnung', due_date = '2026-09-01' WHERE id = $3;`,
        ['Stromanbieter GmbH', 99.9, doc.id]
      );

      const tokenRes = await request(app).post('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);
      const feedUrl = tokenRes.body.feedUrl as string;

      const res = await request(app).get(feedUrl);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/calendar; charset=utf-8/);
      expect(res.text).toContain('BEGIN:VCALENDAR');
      expect(res.text).toContain('Stromanbieter GmbH');
    });

    it('returns 403 for a missing token', async () => {
      const res = await request(app).get('/api/calendar/feed.ics');
      expect(res.status).toBe(403);
    });

    it('returns 403 for an invalid/unknown token', async () => {
      const res = await request(app).get('/api/calendar/feed.ics').query({ token: 'not-a-real-token' });
      expect(res.status).toBe(403);
    });

    it('invalidates the old token after regenerating', async () => {
      const { token } = await loginAsAdmin(app);

      const firstTokenRes = await request(app)
        .post('/api/calendar/feed-token')
        .set('Authorization', `Bearer ${token}`);
      const oldFeedUrl = firstTokenRes.body.feedUrl as string;

      // Sanity check: old token works right after creation.
      const beforeRegen = await request(app).get(oldFeedUrl);
      expect(beforeRegen.status).toBe(200);

      // Regenerate.
      const secondTokenRes = await request(app)
        .post('/api/calendar/feed-token')
        .set('Authorization', `Bearer ${token}`);
      const newFeedUrl = secondTokenRes.body.feedUrl as string;
      expect(newFeedUrl).not.toBe(oldFeedUrl);

      const afterRegenOld = await request(app).get(oldFeedUrl);
      expect(afterRegenOld.status).toBe(403);

      const afterRegenNew = await request(app).get(newFeedUrl);
      expect(afterRegenNew.status).toBe(200);
    });
  });
});
