import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor, loginAs } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';

describe('Granular Tag ACL enforcement (Ticket #19)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeTag(name: string) {
    const res = await query(`INSERT INTO tags (name) VALUES ($1) RETURNING id;`, [name]);
    return res.rows[0].id as string;
  }

  describe('Backward compatibility (no ACLs configured)', () => {
    it('GET /api/documents still returns untagged documents to a non-admin editor', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      await createTestDocument({ title: 'Untagged.pdf' });

      const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.documents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/documents (list) ACL filtering', () => {
    it('hides a document tagged with a restricted tag from an editor with no matching group', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Medical Record.pdf' });
      const tagId = await makeTag('Medical');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.documents.map((d: any) => d.id);
      expect(ids).not.toContain(doc.id);
    });

    it('shows a restricted document to an editor whose group has been granted the tag', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const tagId = await makeTag('Invoices');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const groupRes = await query(`INSERT INTO access_groups (name) VALUES ('Finance') RETURNING id;`);
      const groupId = groupRes.rows[0].id;
      await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [editor.id, groupId]);
      await query(`INSERT INTO group_tag_permissions (group_id, tag_id, can_read) VALUES ($1, $2, true);`, [
        groupId,
        tagId,
      ]);

      const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.documents.map((d: any) => d.id);
      expect(ids).toContain(doc.id);
    });

    it('always shows every document to an admin, regardless of tags/groups', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Medical Record.pdf' });
      const tagId = await makeTag('Medical');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const res = await request(app).get('/api/documents').set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.documents.map((d: any) => d.id);
      expect(ids).toContain(doc.id);
    });
  });

  describe('GET /api/documents/:id (detail) ACL enforcement', () => {
    it('returns 403 for a restricted document and logs an audit entry', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Medical Record.pdf' });
      const tagId = await makeTag('Medical');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const res = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(403);

      const auditRes = await query(
        `SELECT * FROM audit_logs WHERE document_id = $1 AND action = 'acl_denied';`,
        [doc.id]
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 200 for a document the editor has a group grant for', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const tagId = await makeTag('Invoices');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);
      const groupRes = await query(`INSERT INTO access_groups (name) VALUES ('Finance') RETURNING id;`);
      const groupId = groupRes.rows[0].id;
      await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [editor.id, groupId]);
      await query(`INSERT INTO group_tag_permissions (group_id, tag_id, can_read) VALUES ($1, $2, true);`, [
        groupId,
        tagId,
      ]);

      const res = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/documents/:id/file ACL enforcement', () => {
    it('returns 403 and does not stream the file for a restricted document', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Medical Record.pdf' });
      const tagId = await makeTag('Medical');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const res = await request(app)
        .get(`/api/documents/${doc.id}/file`)
        .set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/documents/:id ACL write enforcement', () => {
    it('returns 403 when the editor only has a can_read (not can_write) grant', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const tagId = await makeTag('Invoices');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);
      const groupRes = await query(`INSERT INTO access_groups (name) VALUES ('Finance') RETURNING id;`);
      const groupId = groupRes.rows[0].id;
      await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [editor.id, groupId]);
      await query(
        `INSERT INTO group_tag_permissions (group_id, tag_id, can_read, can_write) VALUES ($1, $2, true, false);`,
        [groupId, tagId]
      );

      const res = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ title: 'Renamed.pdf' });
      expect(res.status).toBe(403);
    });

    it('allows the update when the editor has a can_write grant', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'Invoice.pdf' });
      const tagId = await makeTag('Invoices');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);
      const groupRes = await query(`INSERT INTO access_groups (name) VALUES ('Finance') RETURNING id;`);
      const groupId = groupRes.rows[0].id;
      await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [editor.id, groupId]);
      await query(
        `INSERT INTO group_tag_permissions (group_id, tag_id, can_read, can_write) VALUES ($1, $2, true, true);`,
        [groupId, tagId]
      );

      const res = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ title: 'Renamed.pdf' });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/search ACL filtering', () => {
    it('excludes a restricted document from search results for a non-admin', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const doc = await createTestDocument({ title: 'SecretMedicalReport.pdf' });
      await query(`UPDATE documents SET ocr_text = 'confidential medical data' WHERE id = $1;`, [doc.id]);
      const tagId = await makeTag('Medical');
      await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [doc.id, tagId]);

      const res = await request(app)
        .get('/api/search')
        .query({ q: 'SecretMedicalReport' })
        .set('Authorization', `Bearer ${editorToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.results.map((r: any) => r.id);
      expect(ids).not.toContain(doc.id);
    });
  });

  describe('Admin access-group management endpoints', () => {
    it('lets an admin create a group, add a member, and grant a tag permission', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const editor = await createEditor(app);
      const tagId = await makeTag('Payroll');

      const createRes = await request(app)
        .post('/api/access-groups')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'HR' });
      expect(createRes.status).toBe(201);
      const groupId = createRes.body.group.id;

      const memberRes = await request(app)
        .put(`/api/access-groups/${groupId}/members`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userIds: [editor.id] });
      expect(memberRes.status).toBe(200);

      const permRes = await request(app)
        .put(`/api/access-groups/${groupId}/tag-permissions/${tagId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ canRead: true, canWrite: false, canDelete: false });
      expect(permRes.status).toBe(200);

      const listRes = await request(app).get('/api/access-groups').set('Authorization', `Bearer ${adminToken}`);
      expect(listRes.status).toBe(200);
      const hrGroup = listRes.body.groups.find((g: any) => g.id === groupId);
      expect(Number(hrGroup.member_count)).toBe(1);
      expect(Number(hrGroup.granted_tag_count)).toBe(1);
    });

    it('rejects non-admins from managing access groups', async () => {
      const editor = await createEditor(app);
      const loginRes = await loginAs(app, editor.email, editor.password);
      const editorToken = loginRes.body.token;

      const res = await request(app)
        .post('/api/access-groups')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ name: 'ShouldFail' });
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/access-groups');
      expect(res.status).toBe(401);
    });
  });
});
