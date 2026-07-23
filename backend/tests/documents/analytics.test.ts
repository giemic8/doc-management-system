import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Expense analytics summary', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET /api/analytics/summary', () => {
    it('returns 401 for an unauthenticated request', async () => {
      const res = await request(app).get('/api/analytics/summary');
      expect(res.status).toBe(401);
    });

    it('returns 200 with the three expected top-level keys for an authenticated request', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      await query(
        `UPDATE documents SET sender = $1, amount = $2, document_date = $3 WHERE id = $4;`,
        ['Dell Technologies GmbH', 1499.0, '2026-03-15', doc.id]
      );

      const res = await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('monthlyBreakdown');
      expect(res.body).toHaveProperty('topVendors');
      expect(res.body).toHaveProperty('recurringSubscriptions');
      expect(res.body.topVendors).toEqual([
        expect.objectContaining({ sender: 'Dell Technologies GmbH', total: 1499, count: 1 }),
      ]);
    });

    it('excludes documents outside the given date range', async () => {
      const { token } = await loginAsAdmin(app);
      const inRangeDoc = await createTestDocument({ title: 'InRange.pdf' });
      const outOfRangeDoc = await createTestDocument({ title: 'OutOfRange.pdf' });

      await query(
        `UPDATE documents SET sender = 'InRangeSender', amount = 100, document_date = '2026-03-10' WHERE id = $1;`,
        [inRangeDoc.id]
      );
      await query(
        `UPDATE documents SET sender = 'OutOfRangeSender', amount = 200, document_date = '2025-01-05' WHERE id = $1;`,
        [outOfRangeDoc.id]
      );

      const res = await request(app)
        .get('/api/analytics/summary')
        .query({ start_date: '2026-01-01', end_date: '2026-12-31' })
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const senders = res.body.topVendors.map((v: any) => v.sender);
      expect(senders).toContain('InRangeSender');
      expect(senders).not.toContain('OutOfRangeSender');
    });
  });
});
