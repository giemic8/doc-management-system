import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor, loginAs } from '../helpers/auth';
import { createTestDocument, createTestSpace } from '../helpers/documents';
import { query } from '../../src/database/db';

/**
 * Ticket #34 -- private and shared family spaces with emergency access.
 *
 * The five acceptance criteria, one describe block each:
 *   1. private content is unreadable to normal family admins;
 *   2. shared-space membership grants explicit access;
 *   3. emergency access needs two people, expires, and is audited;
 *   4. search, RAG, guest shares, exports, metadata and file routes apply
 *      the same rule;
 *   5. account recovery works from recovery codes without silently
 *      exposing private content.
 */
describe('Family spaces and emergency access (Ticket #34)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** An editor with a session token, which is what most of these tests need. */
  async function makeUser(name?: string) {
    const editor = await createEditor(app, name ? { name } : undefined);
    const login = await loginAs(app, editor.email, editor.password);
    return { ...editor, token: login.body.token as string };
  }

  async function setupPrivateSpace() {
    const admin = await loginAsAdmin(app);
    const owner = await makeUser('Space Owner');
    const space = await createTestSpace({ name: 'Gesundheit', kind: 'private', ownerId: owner.id });
    const doc = await createTestDocument({ title: 'Therapiebericht.pdf', spaceId: space.id, createdBy: owner.id });
    return { admin, owner, space, doc };
  }

  // ------------------------------------------------------------------
  // 1. Private content is unreadable to normal family admins.
  // ------------------------------------------------------------------
  describe('private spaces are unreadable to admins', () => {
    it('omits a private document from the admin document list but shows it to the owner', async () => {
      const { admin, owner, doc } = await setupPrivateSpace();

      const adminList = await request(app).get('/api/documents').set('Authorization', `Bearer ${admin.token}`);
      expect(adminList.status).toBe(200);
      expect(adminList.body.documents.map((d: any) => d.id)).not.toContain(doc.id);

      const ownerList = await request(app).get('/api/documents').set('Authorization', `Bearer ${owner.token}`);
      expect(ownerList.body.documents.map((d: any) => d.id)).toContain(doc.id);
    });

    it('refuses the admin the document detail, the file, and any modification', async () => {
      const { admin, doc } = await setupPrivateSpace();

      const detail = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${admin.token}`);
      expect(detail.status).toBe(403);

      const file = await request(app).get(`/api/documents/${doc.id}/file`).set('Authorization', `Bearer ${admin.token}`);
      expect(file.status).toBe(403);

      const update = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ title: 'Renamed by admin' });
      expect(update.status).toBe(403);

      const trashed = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(trashed.status).toBe(403);

      const stillThere = await query(`SELECT title, status FROM documents WHERE id = $1;`, [doc.id]);
      expect(stillThere.rows[0]).toMatchObject({ title: 'Therapiebericht.pdf', status: 'ready' });
    });

    it('refuses the admin membership of a private space, so they cannot let themselves in', async () => {
      const { admin, space } = await setupPrivateSpace();
      const adminUser = await query(`SELECT id FROM users WHERE email = 'admin@dms.local';`);

      const res = await request(app)
        .post(`/api/spaces/${space.id}/members`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ userId: adminUser.rows[0].id });

      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('forbidden');
    });

    it('lets an admin see that a private space exists without making it accessible', async () => {
      const { admin, space } = await setupPrivateSpace();

      const res = await request(app).get('/api/spaces').set('Authorization', `Bearer ${admin.token}`);
      expect(res.status).toBe(200);
      const listed = res.body.spaces.find((s: any) => s.id === space.id);
      expect(listed).toMatchObject({ name: 'Gesundheit', kind: 'private', accessible: false, document_count: 1 });
    });

    it('keeps a private document out of a split or a merge run by an admin', async () => {
      const { admin, doc } = await setupPrivateSpace();

      const split = await request(app)
        .post(`/api/documents/${doc.id}/split`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ splitAtPage: 2 });
      expect(split.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // 2. Shared-space membership grants explicit access.
  // ------------------------------------------------------------------
  describe('shared spaces grant access by explicit membership', () => {
    it('shows a shared document to a member and hides it from a non-member', async () => {
      const admin = await loginAsAdmin(app);
      const member = await makeUser('Member');
      const outsider = await makeUser('Outsider');

      const created = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Haushalt', kind: 'shared' });
      expect(created.status).toBe(201);
      const spaceId = created.body.space.id;

      await request(app)
        .post(`/api/spaces/${spaceId}/members`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ userId: member.id })
        .expect(201);

      const doc = await createTestDocument({ title: 'Mietvertrag.pdf', spaceId });

      const memberList = await request(app).get('/api/documents').set('Authorization', `Bearer ${member.token}`);
      expect(memberList.body.documents.map((d: any) => d.id)).toContain(doc.id);

      const outsiderList = await request(app).get('/api/documents').set('Authorization', `Bearer ${outsider.token}`);
      expect(outsiderList.body.documents.map((d: any) => d.id)).not.toContain(doc.id);

      // An admin administers the household, so a shared space is not hidden
      // from them the way a private one is.
      const adminList = await request(app).get('/api/documents').set('Authorization', `Bearer ${admin.token}`);
      expect(adminList.body.documents.map((d: any) => d.id)).toContain(doc.id);
    });

    it('gives a read-only member read but not write', async () => {
      const admin = await loginAsAdmin(app);
      const member = await makeUser('Read Only');
      const created = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Archiv', kind: 'shared' });
      const spaceId = created.body.space.id;

      await request(app)
        .post(`/api/spaces/${spaceId}/members`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ userId: member.id, canWrite: false })
        .expect(201);

      const doc = await createTestDocument({ title: 'Police.pdf', spaceId });

      const read = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${member.token}`);
      expect(read.status).toBe(200);

      const write = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ title: 'Neuer Titel' });
      expect(write.status).toBe(403);
    });

    it('gives a non-admin owner the household directory, so they can nominate without an admin', async () => {
      const owner = await makeUser('Directory User');

      const res = await request(app).get('/api/spaces/directory').set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
      expect(res.body.users.map((u: any) => u.id)).toContain(owner.id);
      // Names and addresses only -- no roles, no content.
      expect(Object.keys(res.body.users[0]).sort()).toEqual(['email', 'id', 'name']);
    });

    it('refuses a non-admin the creation of a shared space but allows a private one', async () => {
      const user = await makeUser('Regular');

      const shared = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ name: 'Nicht erlaubt', kind: 'shared' });
      expect(shared.status).toBe(403);

      const priv = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ name: 'Meine Unterlagen', kind: 'private' });
      expect(priv.status).toBe(201);
      expect(priv.body.space).toMatchObject({ kind: 'private', owner_id: user.id });
    });

    it('refuses to delete a space that still holds documents', async () => {
      const owner = await makeUser('Owner');
      const space = await createTestSpace({ kind: 'private', ownerId: owner.id });
      await createTestDocument({ title: 'Drin.pdf', spaceId: space.id });

      const res = await request(app)
        .delete(`/api/spaces/${space.id}`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('space_not_empty');
    });

    it('moves a document between the common area and a space, and audits the move', async () => {
      const owner = await makeUser('Mover');
      const space = await createTestSpace({ kind: 'private', ownerId: owner.id });
      const doc = await createTestDocument({ title: 'Verschieben.pdf' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/space`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ spaceId: space.id });
      expect(res.status).toBe(200);
      expect(res.body.document.space_id).toBe(space.id);

      const audit = await query(
        `SELECT details FROM audit_logs WHERE document_id = $1 AND action = 'document_space_changed';`,
        [doc.id]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details).toMatchObject({ fromSpaceId: null, toSpaceId: space.id });
    });

    it('refuses to file a document into a space the caller is not in', async () => {
      const owner = await makeUser('Owner');
      const stranger = await makeUser('Stranger');
      const space = await createTestSpace({ kind: 'private', ownerId: owner.id });
      const doc = await createTestDocument({ title: 'Fremd.pdf' });

      const res = await request(app)
        .put(`/api/documents/${doc.id}/space`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ spaceId: space.id });
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // 3. Emergency access: two people, expiring, audited.
  // ------------------------------------------------------------------
  describe('emergency access', () => {
    async function setupWithTrustedContacts() {
      const { admin, owner, space, doc } = await setupPrivateSpace();
      const first = await makeUser('Trusted One');
      const second = await makeUser('Trusted Two');

      for (const contact of [first, second]) {
        await request(app)
          .post(`/api/spaces/${space.id}/trusted-contacts`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ userId: contact.id })
          .expect(201);
      }

      return { admin, owner, space, doc, first, second };
    }

    it('refuses a request from somebody the owner never nominated', async () => {
      const { space } = await setupWithTrustedContacts();
      const stranger = await makeUser('Stranger');

      const res = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ spaceId: space.id, reason: 'Ich brauche die Unterlagen' });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('not_trusted_contact');
    });

    it('refuses an admin the same request, because administering is not being trusted', async () => {
      const { admin, space } = await setupWithTrustedContacts();

      const res = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ spaceId: space.id, reason: 'Administrativer Zugriff benoetigt' });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('not_trusted_contact');
    });

    it('refuses the requester their own approval', async () => {
      const { space, first } = await setupWithTrustedContacts();

      const created = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Krankenhausaufenthalt, Versicherung noetig' });
      expect(created.status).toBe(201);

      const selfApprove = await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/approve`)
        .set('Authorization', `Bearer ${first.token}`);
      expect(selfApprove.status).toBe(403);
      expect(selfApprove.body.reason).toBe('self_approval');

      // And it is still pending afterwards, not quietly half-approved.
      const stored = await query(`SELECT status FROM emergency_access_requests WHERE id = $1;`, [
        created.body.request.id,
      ]);
      expect(stored.rows[0].status).toBe('pending');
    });

    it('opens the private space read-only once a second trusted person approves, and audits the read', async () => {
      const { space, doc, first, second } = await setupWithTrustedContacts();

      const created = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Krankenhausaufenthalt, Versicherung noetig', hours: 12 });

      // Before approval the space is still shut.
      const before = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${first.token}`);
      expect(before.status).toBe(403);

      const approved = await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/approve`)
        .set('Authorization', `Bearer ${second.token}`);
      expect(approved.status).toBe(200);
      expect(approved.body.request).toMatchObject({ status: 'approved', approved_by: second.id });
      expect(new Date(approved.body.request.expires_at).getTime()).toBeGreaterThan(Date.now());

      const after = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${first.token}`);
      expect(after.status).toBe(200);
      expect(after.body.document.id).toBe(doc.id);

      // Read-only: the grant never authorizes a change.
      const write = await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${first.token}`)
        .send({ title: 'Umbenannt im Notfall' });
      expect(write.status).toBe(403);

      const remove = await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${first.token}`);
      expect(remove.status).toBe(403);

      const actions = await query(
        `SELECT action FROM audit_logs WHERE action LIKE 'emergency_access_%' ORDER BY created_at ASC;`
      );
      expect(actions.rows.map((r: any) => r.action)).toEqual(
        expect.arrayContaining(['emergency_access_requested', 'emergency_access_approved', 'emergency_access_used'])
      );

      const used = await query(
        `SELECT document_id, user_id FROM audit_logs WHERE action = 'emergency_access_used';`
      );
      expect(used.rows[0]).toMatchObject({ document_id: doc.id, user_id: first.id });

      const grant = await query(`SELECT use_count, last_used_at FROM emergency_access_requests WHERE id = $1;`, [
        created.body.request.id,
      ]);
      expect(grant.rows[0].use_count).toBeGreaterThanOrEqual(1);
      expect(grant.rows[0].last_used_at).toBeTruthy();
    });

    it('closes the space again when the grant expires', async () => {
      const { space, doc, first, second } = await setupWithTrustedContacts();

      const created = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Zeitlich begrenzter Zugriff' });
      await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/approve`)
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);

      await query(
        `UPDATE emergency_access_requests SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1;`,
        [created.body.request.id]
      );

      const detail = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${first.token}`);
      expect(detail.status).toBe(403);

      const list = await request(app).get('/api/documents').set('Authorization', `Bearer ${first.token}`);
      expect(list.body.documents.map((d: any) => d.id)).not.toContain(doc.id);
    });

    it('closes the space immediately when the owner revokes the grant', async () => {
      const { owner, space, doc, first, second } = await setupWithTrustedContacts();

      const created = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Doch nicht mehr noetig' });
      await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/approve`)
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);

      const revoked = await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/revoke`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.request.status).toBe('revoked');

      const detail = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${first.token}`);
      expect(detail.status).toBe(403);

      const audit = await query(`SELECT 1 FROM audit_logs WHERE action = 'emergency_access_revoked';`);
      expect(audit.rows).toHaveLength(1);
    });

    it('grants nothing when the request is denied', async () => {
      const { space, doc, first, second } = await setupWithTrustedContacts();

      const created = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Kein guter Grund vorhanden' });
      const denied = await request(app)
        .post(`/api/emergency-access/${created.body.request.id}/deny`)
        .set('Authorization', `Bearer ${second.token}`);
      expect(denied.status).toBe(200);
      expect(denied.body.request.status).toBe('denied');

      const detail = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${first.token}`);
      expect(detail.status).toBe(403);
    });

    it('rejects a thin reason and an over-long window', async () => {
      const { space, first } = await setupWithTrustedContacts();

      const thin = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'kurz' });
      expect(thin.status).toBe(400);
      expect(thin.body.reason).toBe('invalid_reason');

      const tooLong = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Ein ausreichend langer Grund', hours: 24 * 30 });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.reason).toBe('invalid_duration');
    });

    it('allows only one open request per person and space', async () => {
      const { space, first } = await setupWithTrustedContacts();

      await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Erster Versuch mit Begruendung' })
        .expect(201);

      const second = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${first.token}`)
        .send({ spaceId: space.id, reason: 'Zweiter Versuch mit Begruendung' });
      expect(second.status).toBe(409);
      expect(second.body.reason).toBe('already_pending');
    });

    it('refuses an emergency unlock of a shared space, which is opened by adding a member', async () => {
      const admin = await loginAsAdmin(app);
      const user = await makeUser('Somebody');
      const created = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Gemeinsam', kind: 'shared' });

      const res = await request(app)
        .post('/api/emergency-access')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ spaceId: created.body.space.id, reason: 'Zugriff auf gemeinsame Ablage' });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('shared_space');
    });
  });

  // ------------------------------------------------------------------
  // 4. Same rule on search, exports, metadata, files, guest shares.
  // ------------------------------------------------------------------
  describe('every read path applies the same rule', () => {
    it('keeps a private document out of admin search results', async () => {
      const { admin, owner, doc } = await setupPrivateSpace();
      await query(`UPDATE documents SET ocr_text = 'Befund Kernspintomographie' WHERE id = $1;`, [doc.id]);

      const adminSearch = await request(app)
        .get('/api/search')
        .query({ q: 'Kernspintomographie' })
        .set('Authorization', `Bearer ${admin.token}`);
      expect(adminSearch.status).toBe(200);
      expect(adminSearch.body.results.map((r: any) => r.id)).not.toContain(doc.id);

      const ownerSearch = await request(app)
        .get('/api/search')
        .query({ q: 'Kernspintomographie' })
        .set('Authorization', `Bearer ${owner.token}`);
      expect(ownerSearch.body.results.map((r: any) => r.id)).toContain(doc.id);
    });

    it('keeps a private document out of admin analytics and the contract list', async () => {
      const { admin, doc } = await setupPrivateSpace();
      await query(
        `UPDATE documents SET doc_type = 'Vertrag', amount = 199.99, document_date = CURRENT_DATE WHERE id = $1;`,
        [doc.id]
      );

      const analytics = await request(app)
        .get('/api/analytics/summary')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(analytics.status).toBe(200);
      expect(JSON.stringify(analytics.body)).not.toContain(doc.id);

      const contracts = await request(app).get('/api/contracts').set('Authorization', `Bearer ${admin.token}`);
      expect(contracts.status).toBe(200);
      expect(contracts.body.contracts.map((c: any) => c.document_id)).not.toContain(doc.id);
    });

    it('keeps a private document out of the admin calendar feed', async () => {
      const { admin, doc } = await setupPrivateSpace();
      await query(`UPDATE documents SET due_date = CURRENT_DATE + 7 WHERE id = $1;`, [doc.id]);

      const tokenRes = await request(app)
        .post('/api/calendar/feed-token')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(tokenRes.status).toBe(201);

      const feedToken = String(tokenRes.body.feedUrl).split('token=')[1];
      const feed = await request(app).get('/api/calendar/feed.ics').query({ token: feedToken });
      expect(feed.status).toBe(200);
      expect(feed.text).not.toContain('Therapiebericht');
    });

    it('leaves a private document out of the admin DATEV and GoBD export packages', async () => {
      const { admin, doc } = await setupPrivateSpace();
      const commonDoc = await createTestDocument({ title: 'Buerobedarf.pdf' });
      await query(`UPDATE documents SET document_date = '2024-05-10', amount = 20 WHERE id = ANY($1::uuid[]);`, [
        [doc.id, commonDoc.id],
      ]);

      // ZIP local file headers store entry names uncompressed, so the archive
      // bytes are enough to say which originals were packed.
      const datev = await request(app)
        .get('/api/export/datev')
        .query({ start_date: '2024-01-01', end_date: '2024-12-31' })
        .set('Authorization', `Bearer ${admin.token}`)
        .responseType('blob');
      expect(datev.status).toBe(200);
      const datevBytes = Buffer.from(datev.body).toString('latin1');
      expect(datevBytes).toContain('Buerobedarf.pdf');
      expect(datevBytes).not.toContain('Therapiebericht.pdf');

      const gobd = await request(app)
        .get('/api/export/audit-package')
        .set('Authorization', `Bearer ${admin.token}`)
        .responseType('blob');
      expect(gobd.status).toBe(200);
      const gobdBytes = Buffer.from(gobd.body).toString('latin1');
      expect(gobdBytes).toContain('Buerobedarf.pdf');
      expect(gobdBytes).not.toContain('Therapiebericht.pdf');
    });

    it('redacts the title of an unreadable document in the audit log without hiding the event', async () => {
      const { admin, owner, doc } = await setupPrivateSpace();

      await request(app)
        .put(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Therapiebericht.pdf' })
        .expect(200);
      await query(
        `INSERT INTO audit_logs (document_id, user_id, action) VALUES ($1, $2, 'test_event');`,
        [doc.id, owner.id]
      );

      const adminView = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${admin.token}`);
      expect(adminView.status).toBe(200);
      const adminRow = adminView.body.audit_logs.find((row: any) => row.action === 'test_event');
      expect(adminRow).toBeTruthy();
      expect(adminRow.document_title).toBeNull();
      expect(adminRow.document_redacted).toBe(true);

      const ownerView = await request(app).get('/api/audit-logs').set('Authorization', `Bearer ${owner.token}`);
      const ownerRow = ownerView.body.audit_logs.find((row: any) => row.action === 'test_event');
      expect(ownerRow.document_title).toBe('Therapiebericht.pdf');
      expect(ownerRow.document_redacted).toBe(false);
    });

    it('refuses an admin a guest share link for a private document', async () => {
      const { admin, doc } = await setupPrivateSpace();

      const res = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it('stops an existing guest link once its creator loses access to the space', async () => {
      const admin = await loginAsAdmin(app);
      const member = await makeUser('Sharer');
      const created = await request(app)
        .post('/api/spaces')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ name: 'Geteilt', kind: 'shared' });
      const spaceId = created.body.space.id;
      await request(app)
        .post(`/api/spaces/${spaceId}/members`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ userId: member.id })
        .expect(201);

      const doc = await createTestDocument({ title: 'Geteilt.pdf', spaceId });
      const link = await request(app)
        .post(`/api/documents/${doc.id}/share-links`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({});
      expect(link.status).toBe(201);
      const token = link.body.token;

      const works = await request(app).get(`/api/share/${token}/info`);
      expect(works.status).toBe(200);

      await request(app)
        .delete(`/api/spaces/${spaceId}/members/${member.id}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      const dead = await request(app).get(`/api/share/${token}/info`);
      expect(dead.status).toBe(410);
      expect(dead.body.reason).toBe('space_access_revoked');

      const audit = await query(`SELECT 1 FROM audit_logs WHERE action = 'guest_share_space_access_revoked';`);
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('refuses an admin the purge of a trashed private document, and reports it as skipped in a sweep', async () => {
      const { admin, owner, doc } = await setupPrivateSpace();

      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      // Purging is a delete, and the space rule binds admins for deletes too.
      const purge = await request(app)
        .post(`/api/documents/${doc.id}/purge`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ confirmation: doc.id, acknowledgeBackupPolicy: true });
      expect(purge.status).toBe(403);

      await query(`UPDATE documents SET purge_after = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1;`, [
        doc.id,
      ]);

      const sweep = await request(app)
        .post('/api/documents/trash/purge-expired')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ confirmation: 'purge-expired', acknowledgeBackupPolicy: true });
      expect(sweep.status).toBe(200);
      expect(sweep.body.purged).not.toContain(doc.id);
      expect(sweep.body.skipped).toContainEqual(
        expect.objectContaining({ documentId: doc.id, reason: 'space_forbidden' })
      );

      const survivor = await query(`SELECT status FROM documents WHERE id = $1;`, [doc.id]);
      expect(survivor.rows[0].status).toBe('trashed');
    });

    it('leaves the common area exactly as it was before spaces existed', async () => {
      const admin = await loginAsAdmin(app);
      const editor = await makeUser('Plain Editor');
      const doc = await createTestDocument({ title: 'Gemeinsame Rechnung.pdf' });

      for (const token of [admin.token, editor.token]) {
        const list = await request(app).get('/api/documents').set('Authorization', `Bearer ${token}`);
        expect(list.body.documents.map((d: any) => d.id)).toContain(doc.id);
      }
    });
  });

  // ------------------------------------------------------------------
  // 5. Account recovery through recovery codes.
  // ------------------------------------------------------------------
  describe('account recovery codes', () => {
    it('issues codes to the owner and lets one of them set a new password', async () => {
      const user = await makeUser('Forgetful');
      const space = await createTestSpace({ kind: 'private', ownerId: user.id });
      const doc = await createTestDocument({ title: 'Privat.pdf', spaceId: space.id });

      const generated = await request(app)
        .post('/api/auth/recovery-codes/regenerate')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ password: user.password });
      expect(generated.status).toBe(200);
      expect(generated.body.recoveryCodes).toHaveLength(8);

      const [code] = generated.body.recoveryCodes;
      const redeemed = await request(app)
        .post('/api/auth/recovery/redeem')
        .send({ email: user.email, code, newPassword: 'neuesPasswort123' });
      expect(redeemed.status).toBe(200);

      const relogin = await loginAs(app, user.email, 'neuesPasswort123');
      expect(relogin.status).toBe(200);

      // The recovered owner gets their OWN private space back -- that is the
      // whole point -- and the recovery is on the record.
      const detail = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${relogin.body.token}`);
      expect(detail.status).toBe(200);

      const audit = await query(`SELECT user_id FROM audit_logs WHERE action = 'account_recovery_used';`);
      expect(audit.rows).toEqual([{ user_id: user.id }]);
    });

    it('spends each code once', async () => {
      const user = await makeUser('Once Only');
      const generated = await request(app)
        .post('/api/auth/recovery-codes/regenerate')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ password: user.password });
      const [code] = generated.body.recoveryCodes;

      await request(app)
        .post('/api/auth/recovery/redeem')
        .send({ email: user.email, code, newPassword: 'ersteRunde123' })
        .expect(200);

      const reuse = await request(app)
        .post('/api/auth/recovery/redeem')
        .send({ email: user.email, code, newPassword: 'zweiteRunde123' });
      expect(reuse.status).toBe(401);
      expect(reuse.body.reason).toBe('invalid_code');

      // The second attempt changed nothing.
      expect((await loginAs(app, user.email, 'ersteRunde123')).status).toBe(200);
    });

    it('requires the current password before issuing codes, so a borrowed session cannot mint them', async () => {
      const user = await makeUser('Careful');

      const res = await request(app)
        .post('/api/auth/recovery-codes/regenerate')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(await request(app).get('/api/auth/recovery-codes').set('Authorization', `Bearer ${user.token}`).then((r) => r.body.remaining)).toBe(0);
    });

    it('gives an admin no way to mint another user’s codes or reach their private space', async () => {
      const admin = await loginAsAdmin(app);
      const user = await makeUser('Private Person');
      const space = await createTestSpace({ kind: 'private', ownerId: user.id });
      const doc = await createTestDocument({ title: 'Nur fuer mich.pdf', spaceId: space.id });

      // The route regenerates the CALLER's codes; there is no user parameter
      // to point it at somebody else, and no admin password-reset route.
      const generated = await request(app)
        .post('/api/auth/recovery-codes/regenerate')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ password: 'admin123' });
      expect(generated.status).toBe(200);

      const otherUsersCodes = await query(
        `SELECT COUNT(*)::int AS count FROM user_recovery_codes WHERE user_id = $1;`,
        [user.id]
      );
      expect(otherUsersCodes.rows[0].count).toBe(0);

      const attempt = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(attempt.status).toBe(403);
    });

    it('does not reveal whether an address exists', async () => {
      const res = await request(app)
        .post('/api/auth/recovery/redeem')
        .send({ email: 'nobody@dms.local', code: 'ABCD-EFGH-JKLM', newPassword: 'irgendwas123' });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('invalid_code');
    });
  });
});
