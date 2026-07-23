import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { query } from '../../src/database/db';
import {
  buildDocumentAclWhereClause,
  canUserAccessDocument,
  canUserModifyDocument,
  canUserDeleteDocument,
} from '../../src/services/acl.service';

describe('acl.service — pure buildDocumentAclWhereClause', () => {
  it('grants admins access regardless of tags/groups (returns empty clause)', () => {
    const params: any[] = [];
    const clause = buildDocumentAclWhereClause({ userId: 'any-user', role: 'admin' }, params);
    expect(clause).toBe('');
    expect(params).toEqual([]);
  });

  it('appends a userId param and a NOT EXISTS clause for non-admins', () => {
    const params: any[] = ['already-here'];
    const clause = buildDocumentAclWhereClause({ userId: 'user-123', role: 'editor' }, params);
    expect(clause).toContain('NOT EXISTS');
    expect(params).toEqual(['already-here', 'user-123']);
    expect(clause).toContain('$2');
  });
});

describe('acl.service — DB-backed visibility rules', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeUser(role: string) {
    const res = await query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', 'Test User', $2) RETURNING id;`,
      [`${Math.random().toString(36).slice(2)}@test.local`, role]
    );
    return res.rows[0].id as string;
  }

  async function makeDocument() {
    const res = await query(
      `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status)
       VALUES ('Test Doc', 'test.pdf', '/tmp/test.pdf', 100, 'application/pdf', 'hash', 'processed')
       RETURNING id;`
    );
    return res.rows[0].id as string;
  }

  async function makeTag(name: string) {
    const res = await query(`INSERT INTO tags (name) VALUES ($1) RETURNING id;`, [name]);
    return res.rows[0].id as string;
  }

  async function makeGroup(name: string) {
    const res = await query(`INSERT INTO access_groups (name) VALUES ($1) RETURNING id;`, [name]);
    return res.rows[0].id as string;
  }

  it('is backward compatible: an untagged document is visible to everyone when no ACLs are configured', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();

    const allowed = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    expect(allowed).toBe(true);
  });

  it('hides a tagged document from a non-admin user with no matching group grant', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const tagId = await makeTag('Medical');
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);

    const allowed = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    expect(allowed).toBe(false);
  });

  it('shows a tagged document to a user whose group has a can_read grant on that tag', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const tagId = await makeTag('Invoices');
    const groupId = await makeGroup('Finance');

    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);
    await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [userId, groupId]);
    await query(`INSERT INTO group_tag_permissions (group_id, tag_id, can_read) VALUES ($1, $2, true);`, [
      groupId,
      tagId,
    ]);

    const allowed = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    expect(allowed).toBe(true);
  });

  it('always grants admins access, even to a tagged document with no matching grant', async () => {
    const adminId = await makeUser('admin');
    const docId = await makeDocument();
    const tagId = await makeTag('Medical');
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);

    const allowed = await canUserAccessDocument({ userId: adminId, role: 'admin' }, docId);
    expect(allowed).toBe(true);
  });

  it('applies "any matching tag grants access" union semantics across multiple tags', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const financeTag = await makeTag('Invoices');
    const medicalTag = await makeTag('Medical');
    const financeGroup = await makeGroup('Finance');

    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2), ($1, $3);`, [
      docId,
      financeTag,
      medicalTag,
    ]);
    await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [userId, financeGroup]);
    await query(`INSERT INTO group_tag_permissions (group_id, tag_id, can_read) VALUES ($1, $2, true);`, [
      financeGroup,
      financeTag,
    ]);

    // User has a grant on ONE of the two tags (Invoices) but not the
    // other (Medical) -- union semantics means the document is still
    // visible.
    const allowed = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    expect(allowed).toBe(true);
  });

  it('does not grant access via a can_read=false grant', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const tagId = await makeTag('Medical');
    const groupId = await makeGroup('SomeGroup');

    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);
    await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [userId, groupId]);
    await query(`INSERT INTO group_tag_permissions (group_id, tag_id, can_read) VALUES ($1, $2, false);`, [
      groupId,
      tagId,
    ]);

    const allowed = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    expect(allowed).toBe(false);
  });

  it('canUserModifyDocument requires can_write, independent of can_read', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const tagId = await makeTag('Invoices');
    const groupId = await makeGroup('Finance');

    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);
    await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [userId, groupId]);
    // Read-only grant: can_read true, can_write false.
    await query(
      `INSERT INTO group_tag_permissions (group_id, tag_id, can_read, can_write) VALUES ($1, $2, true, false);`,
      [groupId, tagId]
    );

    const canRead = await canUserAccessDocument({ userId, role: 'editor' }, docId);
    const canWrite = await canUserModifyDocument({ userId, role: 'editor' }, docId);
    expect(canRead).toBe(true);
    expect(canWrite).toBe(false);
  });

  it('canUserDeleteDocument requires can_delete', async () => {
    const userId = await makeUser('editor');
    const docId = await makeDocument();
    const tagId = await makeTag('Invoices');
    const groupId = await makeGroup('Finance');

    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [docId, tagId]);
    await query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2);`, [userId, groupId]);
    await query(
      `INSERT INTO group_tag_permissions (group_id, tag_id, can_read, can_write, can_delete) VALUES ($1, $2, true, true, false);`,
      [groupId, tagId]
    );

    const canDelete = await canUserDeleteDocument({ userId, role: 'editor' }, docId);
    expect(canDelete).toBe(false);
  });

  it('buildDocumentAclWhereClause correctly filters a list query to only visible documents', async () => {
    const userId = await makeUser('editor');
    const visibleDoc = await makeDocument();
    const hiddenDoc = await makeDocument();
    const tagId = await makeTag('Medical');
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);`, [hiddenDoc, tagId]);
    // visibleDoc stays untagged -- visible to everyone under the
    // backward-compatible "untagged = allowed" rule.

    const params: any[] = [];
    const clause = buildDocumentAclWhereClause({ userId, role: 'editor' }, params);
    const result = await query(`SELECT d.id FROM documents d WHERE ${clause};`, params);
    const ids = result.rows.map((r: any) => r.id);

    expect(ids).toContain(visibleDoc);
    expect(ids).not.toContain(hiddenDoc);
  });
});
