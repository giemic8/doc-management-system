import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { query } from '../../src/database/db';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { createEditor, loginAs } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';

describe('ACL regression coverage for document feature routes', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  async function restrictedDocument(editorId: string, title = 'Restricted.pdf') {
    const doc = await createTestDocument({ title, createdBy: editorId });
    const tag = await query(`INSERT INTO tags (name) VALUES ($1) RETURNING id;`, [`Restricted-${title}`]);
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tag.rows[0].id]);
    return doc;
  }

  async function editorSession() {
    const editor = await createEditor(app);
    const login = await loginAs(app, editor.email, editor.password);
    return { editor, token: login.body.token as string };
  }

  it('blocks restricted document reads, mutations, and share-link management', async () => {
    const { editor, token } = await editorSession();
    const restricted = await restrictedDocument(editor.id);
    const publicDoc = await createTestDocument({ title: 'Public.pdf', createdBy: editor.id });
    const tag = await query(`INSERT INTO tags (name) VALUES ('Bulk target') RETURNING id;`);
    const auth = { Authorization: `Bearer ${token}` };

    const responses = await Promise.all([
      request(app).post(`/api/documents/${restricted.id}/share-links`).set(auth).send({}),
      request(app).get(`/api/documents/${restricted.id}/share-links`).set(auth),
      request(app).delete(`/api/documents/${restricted.id}/share-links/00000000-0000-0000-0000-000000000000`).set(auth),
      request(app).get(`/api/documents/${restricted.id}/sepa-qr`).set(auth).query({ iban: 'DE89370400440532013000' }),
      request(app).post(`/api/documents/${restricted.id}/split`).set(auth).send({ splitAtPage: 1 }),
      request(app).post('/api/documents/merge').set(auth).send({ documentIds: [restricted.id, publicDoc.id] }),
      request(app).post('/api/documents/bulk/tag').set(auth).send({ documentIds: [restricted.id], tagId: tag.rows[0].id }),
      request(app).post('/api/documents/bulk/doc-type').set(auth).send({ documentIds: [restricted.id], docType: 'Vertrag' }),
      request(app).put(`/api/documents/${restricted.id}/custom-fields`).set(auth).send({ values: {} }),
      request(app).put(`/api/contracts/${restricted.id}/details`).set(auth).send({ notice_period_days: 30 }),
      request(app).get(`/api/contracts/${restricted.id}/cancellation-letter`).set(auth),
    ]);

    expect(responses.map((response) => response.status)).toEqual(Array(responses.length).fill(403));

    const denied = await query(
      `SELECT COUNT(*)::int AS count FROM audit_logs WHERE document_id = $1 AND action = 'acl_denied';`,
      [restricted.id]
    );
    expect(denied.rows[0].count).toBeGreaterThanOrEqual(responses.length);
  });

  it('filters restricted metadata from analytics, contracts, and calendar feeds', async () => {
    const { editor, token } = await editorSession();
    const restricted = await restrictedDocument(editor.id, 'Secret Contract.pdf');
    await query(
      `UPDATE documents SET doc_type = 'Vertrag', sender = 'Secret Vendor', amount = 999, due_date = '2026-12-31' WHERE id = $1;`,
      [restricted.id]
    );

    const analytics = await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${token}`);
    expect(analytics.status).toBe(200);
    expect(analytics.body.topVendors).not.toEqual(expect.arrayContaining([expect.objectContaining({ sender: 'Secret Vendor' })]));

    const contracts = await request(app).get('/api/contracts').set('Authorization', `Bearer ${token}`);
    expect(contracts.status).toBe(200);
    expect(contracts.body.contracts.map((contract: any) => contract.document_id)).not.toContain(restricted.id);

    const tokenResponse = await request(app)
      .post('/api/calendar/feed-token')
      .set('Authorization', `Bearer ${token}`);
    const feedToken = tokenResponse.body.feedUrl.split('token=')[1];
    const feed = await request(app).get('/api/calendar/feed.ics').query({ token: feedToken });
    expect(feed.status).toBe(200);
    expect(feed.text).not.toContain('Secret Contract.pdf');
  });
});
