import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import pgvector from 'pgvector';
import axios from 'axios';

vi.mock('axios');

import { app } from '../../src/app';
import { config } from '../../src/config';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';
import { createTestDocument } from '../helpers/documents';
import { query } from '../../src/database/db';
import { generateEmbedding } from '../../src/services/embedding.service';

const DAY_MS = 24 * 60 * 60 * 1000;

async function loginAsEditor() {
  const editor = await createEditor(app);
  const res = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });
  return { token: res.body.token as string, editor };
}

async function trashDocumentViaApi(token: string, documentId: string) {
  const res = await request(app).delete(`/api/documents/${documentId}`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.document;
}

/** Points the backup-policy guard at a status file describing a healthy backup. */
function withHealthyBackupStatus(): { restore: () => void } {
  const statusPath = path.join(os.tmpdir(), `backup-status-${crypto.randomUUID()}.json`);
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      version: 2,
      backupId: 'backup-2026-08-21',
      success: true,
      completedAt: new Date().toISOString(),
      stages: { restored: { state: 'succeeded', at: new Date().toISOString() } },
    })
  );
  const previous = config.backupStatusPath;
  config.backupStatusPath = statusPath;
  return {
    restore: () => {
      config.backupStatusPath = previous;
      fs.rmSync(statusPath, { force: true });
    },
  };
}

describe('90-day trash and controlled purge (Ticket #33)', () => {
  beforeAll(resetDatabase);
  beforeEach(async () => {
    await resetDatabase();
    (axios.post as any) = vi.fn();
  });
  afterAll(closeDatabase);

  describe('normal delete moves a document to the trash', () => {
    it('trashes instead of deleting, records the actor and the 90-day deadline', async () => {
      const { token, user } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Kontoauszug.pdf' });

      const trashed = await trashDocumentViaApi(token, doc.id);

      expect(trashed.status).toBe('trashed');
      expect(trashed.pre_trash_status).toBe('ready');
      expect(trashed.trashed_by).toBe(user.id);
      expect(new Date(trashed.trashed_at).getTime()).toBeGreaterThan(Date.now() - 60_000);

      const daysUntilPurge = (new Date(trashed.purge_after).getTime() - Date.now()) / DAY_MS;
      expect(daysUntilPurge).toBeGreaterThan(89.5);
      expect(daysUntilPurge).toBeLessThan(90.5);

      // The row and both of its file references survive the delete.
      const row = await query(`SELECT status, file_path FROM documents WHERE id = $1;`, [doc.id]);
      expect(row.rows).toHaveLength(1);
      expect(fs.existsSync(row.rows[0].file_path)).toBe(true);

      const audit = await query(`SELECT action, details FROM audit_logs WHERE document_id = $1 AND action = 'trash';`, [
        doc.id,
      ]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details).toMatchObject({ title: 'Kontoauszug.pdf', previousStatus: 'ready' });
    });

    it('accepts POST /:id/trash as well and is idempotent', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Doppelklick.pdf' });

      const first = await request(app)
        .post(`/api/documents/${doc.id}/trash`)
        .set('Authorization', `Bearer ${token}`);
      const second = await request(app)
        .post(`/api/documents/${doc.id}/trash`)
        .set('Authorization', `Bearer ${token}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.document.status).toBe('trashed');
      expect(second.body.document.trashed_at).toBe(first.body.document.trashed_at);
    });

    it('trashes a document that is still processing', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Frisch hochgeladen.pdf', status: 'processing' });

      const trashed = await trashDocumentViaApi(token, doc.id);

      expect(trashed.status).toBe('trashed');
      expect(trashed.pre_trash_status).toBe('processing');
    });

    it('moves every document of a bulk delete into the trash', async () => {
      const { token } = await loginAsAdmin(app);
      const docA = await createTestDocument({ title: 'A.pdf' });
      const docB = await createTestDocument({ title: 'B.pdf' });

      const res = await request(app)
        .post('/api/documents/bulk/delete')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [docA.id, docB.id] });

      expect(res.status).toBe(200);
      expect(res.body.trashed).toBe(2);

      const rows = await query(`SELECT status FROM documents WHERE id = ANY($1::uuid[]);`, [[docA.id, docB.id]]);
      expect(rows.rows).toHaveLength(2);
      rows.rows.forEach((row: any) => expect(row.status).toBe('trashed'));
    });

    it('refuses to trash a document under retention lock or legal hold', async () => {
      const { token } = await loginAsAdmin(app);
      const held = await createTestDocument({ title: 'Legal hold.pdf' });
      const retained = await createTestDocument({ title: 'Aufbewahrung.pdf' });
      await query(`UPDATE documents SET legal_hold = true WHERE id = $1;`, [held.id]);
      await query(`UPDATE documents SET retention_until = CURRENT_DATE + 3650 WHERE id = $1;`, [retained.id]);

      const single = await request(app).delete(`/api/documents/${held.id}`).set('Authorization', `Bearer ${token}`);
      expect(single.status).toBe(423);

      const bulk = await request(app)
        .post('/api/documents/bulk/delete')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [retained.id] });
      expect(bulk.status).toBe(423);
      expect(bulk.body.lockedDocumentIds).toEqual([retained.id]);

      const rows = await query(`SELECT status FROM documents WHERE id = ANY($1::uuid[]);`, [[held.id, retained.id]]);
      rows.rows.forEach((row: any) => expect(row.status).toBe('ready'));
    });
  });

  describe('restore within the recovery window', () => {
    it('restores a trashed document into the state it held before', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Versehentlich.pdf' });
      await trashDocumentViaApi(token, doc.id);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/restore`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.document.status).toBe('ready');
      expect(res.body.document.trashed_at).toBeNull();
      expect(res.body.document.purge_after).toBeNull();
      expect(res.body.document.pre_trash_status).toBeNull();

      const listed = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);
      expect(listed.body.documents.map((d: any) => d.id)).toContain(doc.id);

      const audit = await query(`SELECT details FROM audit_logs WHERE document_id = $1 AND action = 'restore';`, [
        doc.id,
      ]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details).toMatchObject({ restoredTo: 'ready' });
    });

    it('returns a failed document to failed, keeping its failure reason', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'OCR kaputt.pdf', status: 'processing' });
      await query(`SELECT * FROM transition_document($1::uuid, 'failed', 'OCR engine crashed');`, [doc.id]);

      await trashDocumentViaApi(token, doc.id);
      const res = await request(app)
        .post(`/api/documents/${doc.id}/restore`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.document.status).toBe('failed');
      expect(res.body.document.failure_reason).toBe('OCR engine crashed');
    });

    it('still restores after the 90-day window elapsed, as long as nothing purged it', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Uralt.pdf' });
      await trashDocumentViaApi(token, doc.id);
      await query(`UPDATE documents SET purge_after = CURRENT_TIMESTAMP - INTERVAL '5 days' WHERE id = $1;`, [doc.id]);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/restore`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.document.status).toBe('ready');
    });

    it('rejects restoring a document that is not in the trash', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Aktiv.pdf' });

      const res = await request(app)
        .post(`/api/documents/${doc.id}/restore`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('not_trashed');
    });
  });

  describe('GET /api/documents/trash', () => {
    it('lists trashed documents with their remaining recovery window', async () => {
      const { token, user } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Im Papierkorb.pdf' });
      await trashDocumentViaApi(token, doc.id);

      const res = await request(app).get('/api/documents/trash').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.retentionDays).toBe(90);
      expect(res.body.documents).toHaveLength(1);
      expect(res.body.documents[0]).toMatchObject({
        id: doc.id,
        title: 'Im Papierkorb.pdf',
        days_remaining: 90,
        purge_eligible: false,
        retention_locked: false,
        active_share_links: 0,
        trashed_by: user.id,
      });
    });

    it('reports an elapsed window as purge-eligible without hiding the document', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Fällig.pdf' });
      await trashDocumentViaApi(token, doc.id);
      await query(`UPDATE documents SET purge_after = CURRENT_TIMESTAMP - INTERVAL '2 days' WHERE id = $1;`, [doc.id]);

      const res = await request(app).get('/api/documents/trash').set('Authorization', `Bearer ${token}`);

      expect(res.body.documents[0].purge_eligible).toBe(true);
      expect(res.body.documents[0].days_remaining).toBeLessThanOrEqual(-1);
    });
  });

  describe('purge requires explicit authorization', () => {
    it('rejects non-admin users', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const { token: editorToken } = await loginAsEditor();
      const doc = await createTestDocument({ title: 'Nur Admin.pdf' });
      await trashDocumentViaApi(adminToken, doc.id);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });

      expect(res.status).toBe(403);
      const row = await query(`SELECT id FROM documents WHERE id = $1;`, [doc.id]);
      expect(row.rows).toHaveLength(1);
    });

    it('rejects a missing or mistyped confirmation', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Ohne Bestätigung.pdf' });
      await trashDocumentViaApi(token, doc.id);

      const missing = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ acknowledgeBackupPolicy: true });
      const wrong = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: 'yes', acknowledgeBackupPolicy: true });

      expect(missing.status).toBe(400);
      expect(wrong.status).toBe(400);
      expect(wrong.body.reason).toBe('confirmation_required');
      const row = await query(`SELECT id FROM documents WHERE id = $1;`, [doc.id]);
      expect(row.rows).toHaveLength(1);
    });

    it('refuses to purge a document that was never trashed', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Noch aktiv.pdf' });

      const res = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('not_trashed');
    });

    it('destroys both durable copies, versions and the row, and records an audit event', async () => {
      const { token } = await loginAsAdmin(app);
      const uploadPath = path.join(os.tmpdir(), `purge-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(uploadPath, 'Bytes that the purge must destroy.');
      const uploadRes = await request(app)
        .post('/api/documents/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', uploadPath);
      expect(uploadRes.status).toBe(201);
      const doc = uploadRes.body.document;

      // A stored version file must not survive the purge either.
      const versionPath = path.join(os.tmpdir(), `version-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(versionPath, 'Older revision of the same document.');
      await query(
        `INSERT INTO document_versions (document_id, version, file_path, file_size, file_hash)
         VALUES ($1, 1, $2, 10, 'deadbeef');`,
        [doc.id, versionPath]
      );

      await trashDocumentViaApi(token, doc.id);

      const backup = withHealthyBackupStatus();
      let res;
      try {
        res = await request(app)
          .post(`/api/documents/${doc.id}/purge`)
          .set('Authorization', `Bearer ${token}`)
          .send({ confirmation: doc.id });
      } finally {
        backup.restore();
      }

      expect(res!.status).toBe(200);
      expect(res!.body).toMatchObject({ purged: true, documentId: doc.id, versionsRemoved: 1 });
      expect(res!.body.failedFiles).toEqual([]);

      expect(fs.existsSync(doc.file_path)).toBe(false);
      expect(fs.existsSync(doc.replica_file_path)).toBe(false);
      expect(fs.existsSync(versionPath)).toBe(false);

      const row = await query(`SELECT id FROM documents WHERE id = $1;`, [doc.id]);
      expect(row.rows).toHaveLength(0);

      // audit_logs.document_id is nulled by the foreign key, so the event
      // has to carry the identity itself.
      const audit = await query(`SELECT document_id, details FROM audit_logs WHERE action = 'purge';`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].document_id).toBeNull();
      expect(audit.rows[0].details).toMatchObject({ documentId: doc.id, versionsRemoved: 1 });
      expect(audit.rows[0].details.backupId).toBe('backup-2026-08-21');
    });
  });

  describe('purge guards', () => {
    it('refuses while no successful backup is on record, and proceeds once acknowledged', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Ohne Backup.pdf' });
      await trashDocumentViaApi(token, doc.id);

      const refused = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id });

      expect(refused.status).toBe(409);
      expect(refused.body.reason).toBe('backup_unavailable');

      const acknowledged = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });

      expect(acknowledged.status).toBe(200);
      const audit = await query(`SELECT details FROM audit_logs WHERE action = 'purge';`);
      expect(audit.rows[0].details.acknowledgedBackupPolicy).toBe(true);
    });

    it('refuses to purge a document under retention lock or legal hold', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'GoBD.pdf' });
      await trashDocumentViaApi(token, doc.id);
      await query(`UPDATE documents SET legal_hold = true WHERE id = $1;`, [doc.id]);

      const res = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });

      expect(res.status).toBe(423);
      expect(res.body.reason).toBe('retention_locked');
      const row = await query(`SELECT id FROM documents WHERE id = $1;`, [doc.id]);
      expect(row.rows).toHaveLength(1);
    });

    it('refuses while share links are still active, and revokes them when told to', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Geteilt.pdf' });
      const shareRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(shareRes.status).toBe(201);
      await trashDocumentViaApi(token, doc.id);

      const refused = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'active_share_links', activeShareLinks: 1 });

      const purged = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true, revokeShareLinks: true });

      expect(purged.status).toBe(200);
      expect(purged.body.revokedShareLinks).toBe(1);
    });
  });

  describe('POST /api/documents/trash/purge-expired', () => {
    it('purges only documents past their recovery window and reports what it skipped', async () => {
      const { token } = await loginAsAdmin(app);
      const expired = await createTestDocument({ title: 'Abgelaufen.pdf' });
      const fresh = await createTestDocument({ title: 'Frisch.pdf' });
      const locked = await createTestDocument({ title: 'Gesperrt.pdf' });
      for (const doc of [expired, fresh, locked]) {
        await trashDocumentViaApi(token, doc.id);
      }
      await query(
        `UPDATE documents SET purge_after = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = ANY($1::uuid[]);`,
        [[expired.id, locked.id]]
      );
      await query(`UPDATE documents SET legal_hold = true WHERE id = $1;`, [locked.id]);

      const res = await request(app)
        .post('/api/documents/trash/purge-expired')
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: 'purge-expired', acknowledgeBackupPolicy: true });

      expect(res.status).toBe(200);
      expect(res.body.purged).toEqual([expired.id]);
      expect(res.body.skipped).toEqual([
        { documentId: locked.id, reason: 'retention_locked', error: expect.any(String) },
      ]);

      const remaining = await query(`SELECT id FROM documents ORDER BY title;`);
      expect(remaining.rows.map((r: any) => r.id).sort()).toEqual([fresh.id, locked.id].sort());
    });

    it('requires the typed confirmation and admin role', async () => {
      const { token } = await loginAsAdmin(app);
      const { token: editorToken } = await loginAsEditor();

      const unconfirmed = await request(app)
        .post('/api/documents/trash/purge-expired')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      const asEditor = await request(app)
        .post('/api/documents/trash/purge-expired')
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ confirmation: 'purge-expired' });

      expect(unconfirmed.status).toBe(400);
      expect(asEditor.status).toBe(403);
    });
  });

  describe('trashed documents drop out of normal use', () => {
    it('disappears from the document list and from search', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Suchbare Rechnung.pdf' });

      const beforeSearch = await request(app)
        .get('/api/search')
        .query({ q: 'Suchbare' })
        .set('Authorization', `Bearer ${token}`);
      expect(beforeSearch.body.results.map((r: any) => r.id)).toContain(doc.id);

      await trashDocumentViaApi(token, doc.id);

      const list = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);
      expect(list.body.documents.map((d: any) => d.id)).not.toContain(doc.id);

      const afterSearch = await request(app)
        .get('/api/search')
        .query({ q: 'Suchbare' })
        .set('Authorization', `Bearer ${token}`);
      expect(afterSearch.body.results.map((r: any) => r.id)).not.toContain(doc.id);
    });

    it('is not retrieved as RAG evidence', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Police.pdf' });
      const chunkText = 'Die Versicherungsprämie für das Jahr 2025 betrug 450 EUR.';
      await query(
        `INSERT INTO document_chunks (document_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, $2, $3);`,
        [doc.id, chunkText, pgvector.toSql(generateEmbedding(chunkText))]
      );
      await trashDocumentViaApi(token, doc.id);

      (axios.post as any) = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ data: { response: 'Keine Belege gefunden.' } });

      const res = await request(app)
        .post('/api/chat/query')
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'Wie hoch war die Versicherungsprämie 2025?' });

      expect(res.status).toBe(200);
      expect(res.body.citations).toHaveLength(0);
    });

    it('disappears from analytics, the contract list and the calendar feed', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Mietvertrag.pdf' });
      await query(
        `UPDATE documents SET doc_type = 'Vertrag', sender = 'Hausverwaltung GmbH', amount = 800,
                document_date = CURRENT_DATE, due_date = CURRENT_DATE + 10 WHERE id = $1;`,
        [doc.id]
      );
      const feedRes = await request(app).post('/api/calendar/feed-token').set('Authorization', `Bearer ${token}`);
      const feedToken = feedRes.body.feedUrl.split('token=')[1];

      const analyticsBefore = await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${token}`);
      expect(analyticsBefore.body.topVendors.map((v: any) => v.sender)).toContain('Hausverwaltung GmbH');
      const contractsBefore = await request(app).get('/api/contracts').set('Authorization', `Bearer ${token}`);
      expect(contractsBefore.body.contracts.map((c: any) => c.document_id)).toContain(doc.id);
      const feedBefore = await request(app).get('/api/calendar/feed.ics').query({ token: feedToken });
      expect(feedBefore.text).toContain('Mietvertrag.pdf');

      await trashDocumentViaApi(token, doc.id);

      const analyticsAfter = await request(app).get('/api/analytics/summary').set('Authorization', `Bearer ${token}`);
      expect(analyticsAfter.body.topVendors.map((v: any) => v.sender)).not.toContain('Hausverwaltung GmbH');
      const contractsAfter = await request(app).get('/api/contracts').set('Authorization', `Bearer ${token}`);
      expect(contractsAfter.body.contracts.map((c: any) => c.document_id)).not.toContain(doc.id);
      const feedAfter = await request(app).get('/api/calendar/feed.ics').query({ token: feedToken });
      expect(feedAfter.text).not.toContain('Mietvertrag.pdf');
    });

    it('cannot be edited, tagged or split while it sits in the trash', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Nicht mehr bearbeitbar.pdf' });
      const tagRes = await query(`INSERT INTO tags (name) VALUES ('TrashGuard') RETURNING id;`);
      await trashDocumentViaApi(token, doc.id);

      const metadata = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Umbenannt.pdf' });
      const tagging = await request(app)
        .post('/api/documents/bulk/tag')
        .set('Authorization', `Bearer ${token}`)
        .send({ documentIds: [doc.id], tagId: tagRes.rows[0].id });
      const split = await request(app)
        .post(`/api/documents/${doc.id}/split`)
        .set('Authorization', `Bearer ${token}`)
        .send({ splitAtPage: 1 });

      expect(metadata.status).toBe(409);
      expect(metadata.body.reason).toBe('document_trashed');
      expect(tagging.status).toBe(409);
      expect(split.status).toBe(409);

      const unchanged = await query(`SELECT title FROM documents WHERE id = $1;`, [doc.id]);
      expect(unchanged.rows[0].title).toBe('Nicht mehr bearbeitbar.pdf');
    });

    it('cuts off guest share links and refuses new ones', async () => {
      const { token } = await loginAsAdmin(app);
      const doc = await createTestDocument({ title: 'Geteiltes Dokument.pdf' });
      const shareRes = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      const shareToken = shareRes.body.token;

      const infoBefore = await request(app).get(`/api/share/${shareToken}/info`);
      expect(infoBefore.status).toBe(200);

      await trashDocumentViaApi(token, doc.id);

      const infoAfter = await request(app).get(`/api/share/${shareToken}/info`);
      expect(infoAfter.status).toBe(410);
      expect(infoAfter.body.reason).toBe('document_deleted');

      const downloadAfter = await request(app).get(`/api/share/${shareToken}/download`);
      expect(downloadAfter.status).toBe(410);

      const newLink = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(newLink.status).toBe(409);
      expect(newLink.body.reason).toBe('document_trashed');
    });
  });
});
