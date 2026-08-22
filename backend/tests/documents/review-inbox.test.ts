import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from '../../src/app';
import { query } from '../../src/database/db';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor, loginAs } from '../helpers/auth';
import { createTestDocument, createTestSpace } from '../helpers/documents';
import { ingestDocument } from '../../src/services/ingestion.service';
import { jaccardSimilarity, scanDocumentForSimilarity, tokenize } from '../../src/services/duplicateDetection.service';

/**
 * Ticket #35 -- review inbox and duplicate detection.
 *
 * The five acceptance criteria, one describe block each:
 *   1. confidence thresholds are configurable and tested;
 *   2. exact hash duplicates link without a second original write;
 *   3. similarity detection never merges automatically;
 *   4. a reviewer can accept, correct, retry, or separate candidates;
 *   5. review state survives worker and provider restarts.
 *
 * Plus the visibility regressions this feature could otherwise open: the
 * inbox is a document list, so it answers to the same rules as one.
 */

const INVOICE_TEXT = [
  'Stadtwerke Musterstadt GmbH Rechnung Nummer 2026-4711 Rechnungsdatum 24.03.2026',
  'Lieferstelle Hauptstrasse 12 Musterstadt Zaehlernummer 8891234 Verbrauch 2150 Kilowattstunden',
  'Abschlagszahlung monatlich Betrag 49,90 Euro faellig innerhalb vierzehn Tagen Bankverbindung',
  'IBAN DE02120300000000202051 Verwendungszweck Kundennummer 55512 Vielen Dank fuer Ihr Vertrauen',
].join(' ');

const UNRELATED_TEXT = [
  'Zahnarztpraxis Doktor Sommer Terminbestaetigung Kontrolluntersuchung Prophylaxe Zahnreinigung',
  'Bitte bringen Sie Ihren Bonusheft und die Versichertenkarte mit Wartezimmer Erdgeschoss',
  'Absage bitte spaetestens vierundzwanzig Stunden vorher telefonisch unter Rufnummer',
].join(' ');

describe('Review inbox and duplicate detection (Ticket #35)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeUser(name?: string) {
    const editor = await createEditor(app, name ? { name } : undefined);
    const login = await loginAs(app, editor.email, editor.password);
    return { ...editor, token: login.body.token as string };
  }

  /** What the worker does: store a proposal and let the thresholds classify it. */
  async function recordProposal(documentId: string, field: string, value: unknown, confidence: number) {
    const result = await query(`SELECT * FROM record_extraction($1, $2, $3::jsonb, $4, 'ollama', 'llama3');`, [
      documentId,
      field,
      JSON.stringify(value),
      confidence,
    ]);
    return result.rows[0];
  }

  /** The rest of what the worker does once every field has been recorded. */
  async function finishProcessing(documentId: string) {
    const applied = await query('SELECT apply_document_extractions($1) AS needs_review;', [documentId]);
    const settled = await query('SELECT settle_document_review($1) AS status;', [documentId]);
    return { needsReview: applied.rows[0].needs_review as boolean, status: settled.rows[0].status as string };
  }

  async function openItemsFor(documentId: string) {
    const result = await query(
      `SELECT * FROM review_items WHERE document_id = $1 AND status = 'open' ORDER BY kind;`,
      [documentId]
    );
    return result.rows;
  }

  async function documentRow(documentId: string) {
    const result = await query('SELECT * FROM documents WHERE id = $1;', [documentId]);
    return result.rows[0];
  }

  async function stage(contents: string): Promise<string> {
    const stagedPath = path.join(os.tmpdir(), `review-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(stagedPath, contents);
    return stagedPath;
  }

  // ---------------------------------------------------------------------
  // 1. Confidence thresholds are configurable and tested
  // ---------------------------------------------------------------------
  describe('confidence thresholds are configurable', () => {
    it('applies a confident proposal and holds an uncertain one back', async () => {
      const document = await createTestDocument({ status: 'processing' });

      await recordProposal(document.id, 'doc_type', 'Rechnung', 0.95);
      await recordProposal(document.id, 'sender', 'Stadtwerke Musterstadt GmbH', 0.62);
      await recordProposal(document.id, 'amount', 49.9, 0.2);

      const { needsReview, status } = await finishProcessing(document.id);
      const stored = await documentRow(document.id);

      expect(needsReview).toBe(true);
      expect(status).toBe('review');
      // The confident one landed on the document...
      expect(stored.doc_type).toBe('Rechnung');
      // ...the uncertain ones did not, in either direction.
      expect(stored.sender).toBeNull();
      expect(stored.amount).toBeNull();

      const extractions = await query(
        'SELECT field, decision FROM document_extractions WHERE document_id = $1 ORDER BY field;',
        [document.id]
      );
      expect(extractions.rows).toEqual([
        { field: 'amount', decision: 'discarded' },
        { field: 'doc_type', decision: 'auto_accepted' },
        { field: 'sender', decision: 'needs_review' },
      ]);
    });

    it('reclassifies the same confidence when an administrator moves the bar', async () => {
      const admin = await loginAsAdmin(app);

      const raised = await request(app)
        .put('/api/review/settings')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ autoAcceptConfidence: 0.99, reviewConfidence: 0.3 });
      expect(raised.status).toBe(200);
      expect(raised.body.settings).toMatchObject({ autoAcceptConfidence: 0.99, reviewConfidence: 0.3 });

      const document = await createTestDocument({ status: 'processing' });
      const proposal = await recordProposal(document.id, 'doc_type', 'Rechnung', 0.95);

      // Same 0.95 that was auto-accepted under the default bar.
      expect(proposal.decision).toBe('needs_review');
      const { status } = await finishProcessing(document.id);
      expect(status).toBe('review');
      expect((await documentRow(document.id)).doc_type).toBeNull();
    });

    it('refuses thresholds that would make the inbox unreachable', async () => {
      const admin = await loginAsAdmin(app);

      const inverted = await request(app)
        .put('/api/review/settings')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ autoAcceptConfidence: 0.4, reviewConfidence: 0.8 });
      expect(inverted.status).toBe(400);
      expect(inverted.body.reason).toBe('thresholds_out_of_order');

      const outOfRange = await request(app)
        .put('/api/review/settings')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ duplicateSimilarity: 1.4 });
      expect(outOfRange.status).toBe(400);
      expect(outOfRange.body.reason).toBe('invalid_threshold');

      // Neither attempt changed anything.
      const settings = await request(app)
        .get('/api/review/settings')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(settings.body.settings).toMatchObject({
        autoAcceptConfidence: 0.85,
        reviewConfidence: 0.5,
        duplicateSimilarity: 0.9,
      });
    });

    it('lets everyone read the thresholds and only an administrator change them', async () => {
      const editor = await makeUser('Reviewer');

      const read = await request(app).get('/api/review/settings').set('Authorization', `Bearer ${editor.token}`);
      expect(read.status).toBe(200);
      expect(read.body.settings.autoAcceptConfidence).toBe(0.85);

      const write = await request(app)
        .put('/api/review/settings')
        .set('Authorization', `Bearer ${editor.token}`)
        .send({ autoAcceptConfidence: 0.1 });
      expect(write.status).toBe(403);
    });

    it('records a threshold change in the audit log', async () => {
      const admin = await loginAsAdmin(app);
      await request(app)
        .put('/api/review/settings')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ autoAcceptConfidence: 0.9 });

      const audit = await query(`SELECT details FROM audit_logs WHERE action = 'review_settings_changed';`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details.to.autoAcceptConfidence).toBe(0.9);
    });
  });

  // ---------------------------------------------------------------------
  // 2. Exact hash duplicates link without a second original write
  // ---------------------------------------------------------------------
  describe('exact duplicates', () => {
    it('links the second delivery into the first copies instead of writing them again', async () => {
      const first = await ingestDocument({
        stagedPath: await stage('identical original bytes for the duplicate test'),
        source: 'watchfolder',
        idempotencyKey: `scan-a-${crypto.randomUUID()}`,
        filename: 'Rechnung.pdf',
        mimeType: 'application/pdf',
      });
      const second = await ingestDocument({
        stagedPath: await stage('identical original bytes for the duplicate test'),
        source: 'watchfolder',
        idempotencyKey: `scan-b-${crypto.randomUUID()}`,
        filename: 'Rechnung (Kopie).pdf',
        mimeType: 'application/pdf',
      });

      expect(second.document.id).not.toBe(first.document.id);

      // Both documents have their own path, but those paths are the same
      // bytes on disk: the original was not written a second time.
      const firstStat = fs.statSync(first.document.file_path);
      const secondStat = fs.statSync(second.document.file_path);
      expect(secondStat.ino).toBe(firstStat.ino);
      expect(fs.statSync(second.document.replica_file_path!).ino).toBe(
        fs.statSync(first.document.replica_file_path!).ino
      );

      const link = await query('SELECT * FROM document_duplicate_links;');
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0]).toMatchObject({ kind: 'exact', status: 'candidate' });
      expect(Number(link.rows[0].similarity)).toBe(1);

      const items = await openItemsFor(second.document.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'exact_duplicate', duplicate_of: first.document.id });
    });

    it('puts the duplicate in the inbox even when every extracted field was confident', async () => {
      const first = await ingestDocument({
        stagedPath: await stage('confident duplicate bytes'),
        source: 'watchfolder',
        idempotencyKey: `conf-a-${crypto.randomUUID()}`,
        filename: 'Beitragsrechnung.pdf',
        mimeType: 'application/pdf',
      });
      const second = await ingestDocument({
        stagedPath: await stage('confident duplicate bytes'),
        source: 'watchfolder',
        idempotencyKey: `conf-b-${crypto.randomUUID()}`,
        filename: 'Beitragsrechnung.pdf',
        mimeType: 'application/pdf',
      });

      await recordProposal(second.document.id, 'doc_type', 'Rechnung', 0.99);
      const { needsReview, status } = await finishProcessing(second.document.id);

      expect(needsReview).toBe(false); // no field is in doubt...
      expect(status).toBe('review'); // ...but the duplicate question still is.
      expect((await documentRow(first.document.id)).status).toBe('processing');
    });

    it('does not report a duplicate across a space boundary', async () => {
      const owner = await makeUser('Space Owner');
      const space = await createTestSpace({ name: 'Gesundheit', kind: 'private', ownerId: owner.id });

      const inPrivateSpace = await ingestDocument({
        stagedPath: await stage('bytes that exist in two different spaces'),
        source: 'browser',
        idempotencyKey: `space-a-${crypto.randomUUID()}`,
        filename: 'Befund.pdf',
        mimeType: 'application/pdf',
        createdBy: owner.id,
        spaceId: space.id,
      });
      const inCommonArea = await ingestDocument({
        stagedPath: await stage('bytes that exist in two different spaces'),
        source: 'browser',
        idempotencyKey: `space-b-${crypto.randomUUID()}`,
        filename: 'Befund.pdf',
        mimeType: 'application/pdf',
      });

      expect(inPrivateSpace.document.space_id).toBe(space.id);
      expect(inCommonArea.document.space_id).toBeNull();

      // "You already have this file" is information about a space's
      // contents, so it stays inside the space it is about.
      expect((await query('SELECT * FROM document_duplicate_links;')).rows).toHaveLength(0);
      expect(await openItemsFor(inCommonArea.document.id)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 3. Similarity detection never merges automatically
  // ---------------------------------------------------------------------
  describe('similarity detection', () => {
    async function documentWithText(title: string, text: string, overrides: { spaceId?: string | null } = {}) {
      const document = await createTestDocument({ title, status: 'ready', spaceId: overrides.spaceId ?? null });
      await query('UPDATE documents SET ocr_text = $2 WHERE id = $1;', [document.id, text]);
      return document;
    }

    it('scores overlap without touching either document', async () => {
      const original = await documentWithText('Stromrechnung.pdf', INVOICE_TEXT);
      const rescan = await documentWithText('Stromrechnung_Scan2.pdf', `${INVOICE_TEXT} Zweitschrift`);

      const result = await scanDocumentForSimilarity(rescan.id);

      expect(result.scanned).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].documentId).toBe(original.id);
      expect(result.matches[0].similarity).toBeGreaterThanOrEqual(0.9);

      // Nothing was merged, replaced, retitled or removed.
      expect(await documentRow(original.id)).toMatchObject({ title: 'Stromrechnung.pdf', status: 'ready' });
      expect(await documentRow(rescan.id)).toMatchObject({ title: 'Stromrechnung_Scan2.pdf' });

      const link = await query('SELECT * FROM document_duplicate_links;');
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0]).toMatchObject({ kind: 'similar', status: 'candidate', decided_by: null });

      // The open question moves the document into the inbox.
      expect((await documentRow(rescan.id)).status).toBe('review');
      expect(await openItemsFor(rescan.id)).toHaveLength(1);
    });

    it('leaves unrelated documents alone and records that it looked', async () => {
      await documentWithText('Stromrechnung.pdf', INVOICE_TEXT);
      const unrelated = await documentWithText('Zahnarzt.pdf', UNRELATED_TEXT);

      const result = await scanDocumentForSimilarity(unrelated.id);

      expect(result.matches).toHaveLength(0);
      expect(result.candidates).toBe(1);
      expect((await query('SELECT * FROM document_duplicate_links;')).rows).toHaveLength(0);
      expect((await documentRow(unrelated.id)).similarity_scanned_at).not.toBeNull();
      expect((await documentRow(unrelated.id)).status).toBe('ready');
    });

    it('never compares across a space boundary', async () => {
      const owner = await makeUser('Space Owner');
      const space = await createTestSpace({ name: 'Gesundheit', kind: 'private', ownerId: owner.id });

      await documentWithText('Stromrechnung.pdf', INVOICE_TEXT, { spaceId: space.id });
      const common = await documentWithText('Stromrechnung_Kopie.pdf', `${INVOICE_TEXT} Zweitschrift`);

      const result = await scanDocumentForSimilarity(common.id);

      expect(result.candidates).toBe(0);
      expect(result.matches).toHaveLength(0);
    });

    it('never asks about a pair a reviewer has already separated', async () => {
      const admin = await loginAsAdmin(app);
      const original = await documentWithText('Stromrechnung.pdf', INVOICE_TEXT);
      const rescan = await documentWithText('Stromrechnung_Scan2.pdf', `${INVOICE_TEXT} Zweitschrift`);

      await scanDocumentForSimilarity(rescan.id);
      const [item] = await openItemsFor(rescan.id);

      const separated = await request(app)
        .post(`/api/review/${item.id}/separate`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ note: 'Zwei getrennte Abrechnungszeitraeume' });
      expect(separated.status).toBe(200);

      // Re-running the scan from scratch must not resurrect the question.
      await query('UPDATE documents SET similarity_scanned_at = NULL WHERE id = $1;', [rescan.id]);
      const second = await scanDocumentForSimilarity(rescan.id);

      expect(second.matches).toHaveLength(0);
      expect(await openItemsFor(rescan.id)).toHaveLength(0);
      const link = await query('SELECT * FROM document_duplicate_links;');
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0].status).toBe('separated');
      // Both documents are still there. Separating is an answer, not a delete.
      expect(await documentRow(original.id)).toBeTruthy();
      expect(await documentRow(rescan.id)).toBeTruthy();
    });

    it('computes the overlap it claims to compute', () => {
      expect(jaccardSimilarity(tokenize('rechnung stadtwerke betrag'), tokenize('rechnung stadtwerke betrag'))).toBe(1);
      expect(jaccardSimilarity(tokenize('rechnung stadtwerke'), tokenize('zahnarzt termin'))).toBe(0);
      // Two of three shared, four distinct in total.
      expect(
        jaccardSimilarity(tokenize('rechnung stadtwerke betrag'), tokenize('rechnung stadtwerke gebuehr'))
      ).toBeCloseTo(0.5, 5);
      // An empty document is unknown, not identical to another empty one.
      expect(jaccardSimilarity(tokenize(''), tokenize(''))).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // 4. Reviewer can accept, correct, retry, or separate candidates
  // ---------------------------------------------------------------------
  describe('reviewer actions', () => {
    async function documentInReview() {
      const admin = await loginAsAdmin(app);
      const document = await createTestDocument({ status: 'processing' });
      await recordProposal(document.id, 'doc_type', 'Rechnung', 0.6);
      await recordProposal(document.id, 'sender', 'Stadtwerke Musterstadt GmbH', 0.6);
      await finishProcessing(document.id);
      const [item] = await openItemsFor(document.id);
      return { admin, document, item };
    }

    it('lists the open question with its proposals and their confidence', async () => {
      const { admin, document } = await documentInReview();

      const listed = await request(app).get('/api/review').set('Authorization', `Bearer ${admin.token}`);

      expect(listed.status).toBe(200);
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toMatchObject({
        documentId: document.id,
        kind: 'low_confidence',
        status: 'open',
        documentStatus: 'review',
      });
      expect(listed.body.items[0].detail.fields).toEqual(['doc_type', 'sender']);
      expect(listed.body.items[0].proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'sender', confidence: 0.6, decision: 'needs_review', provider: 'ollama' }),
        ])
      );
    });

    it('accepts the proposals as they stand and releases the document', async () => {
      const { admin, document, item } = await documentInReview();

      const accepted = await request(app)
        .post(`/api/review/${item.id}/accept`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(accepted.status).toBe(200);
      expect(accepted.body.appliedFields.sort()).toEqual(['doc_type', 'sender']);
      expect(accepted.body.documentStatus).toBe('ready');

      const stored = await documentRow(document.id);
      expect(stored).toMatchObject({ doc_type: 'Rechnung', sender: 'Stadtwerke Musterstadt GmbH', status: 'ready' });
      expect(await openItemsFor(document.id)).toHaveLength(0);
    });

    it('stores a reviewer correction as a decision, not a guess', async () => {
      const { admin, document, item } = await documentInReview();

      const corrected = await request(app)
        .post(`/api/review/${item.id}/correct`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ values: { sender: 'Stadtwerke Musterstadt AG', document_date: '2026-03-24', tags: ['Energie'] } });

      expect(corrected.status).toBe(200);
      expect(corrected.body.documentStatus).toBe('ready');

      const stored = await documentRow(document.id);
      expect(stored.sender).toBe('Stadtwerke Musterstadt AG');
      expect(stored.document_date.toISOString().slice(0, 10)).toBe('2026-03-24');

      const human = await query(
        `SELECT field, confidence, provider, resolved_by FROM document_extractions
         WHERE document_id = $1 AND provider = 'human' ORDER BY field;`,
        [document.id]
      );
      expect(human.rows.map((row: any) => row.field)).toEqual(['document_date', 'sender', 'tags']);
      expect(human.rows.every((row: any) => Number(row.confidence) === 1)).toBe(true);
      expect(human.rows.every((row: any) => row.resolved_by)).toBe(true);

      const tagged = await query(
        `SELECT t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = $1;`,
        [document.id]
      );
      expect(tagged.rows.map((row: any) => row.name)).toContain('Energie');
    });

    it('refuses a correction the column cannot hold and stores none of it', async () => {
      const { admin, document, item } = await documentInReview();

      const rejected = await request(app)
        .post(`/api/review/${item.id}/correct`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ values: { sender: 'Stadtwerke Musterstadt AG', document_date: 'irgendwann im Maerz' } });

      expect(rejected.status).toBe(400);
      expect(rejected.body).toMatchObject({ reason: 'invalid_value', field: 'document_date' });

      const stored = await documentRow(document.id);
      expect(stored.sender).toBeNull();
      expect(stored.document_date).toBeNull();
      expect(await openItemsFor(document.id)).toHaveLength(1);
    });

    it('refuses a field it does not know', async () => {
      const { admin, item } = await documentInReview();

      const rejected = await request(app)
        .post(`/api/review/${item.id}/correct`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ values: { password_hash: 'nope' } });

      expect(rejected.status).toBe(400);
      expect(rejected.body.reason).toBe('unknown_field');
    });

    it('sends a document back for another try without declaring it ready', async () => {
      const { admin, document, item } = await documentInReview();
      await query('UPDATE documents SET similarity_scanned_at = CURRENT_TIMESTAMP WHERE id = $1;', [document.id]);

      const retried = await request(app)
        .post(`/api/review/${item.id}/retry`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(retried.status).toBe(200);
      expect(retried.body.documentStatus).toBe('processing');

      const stored = await documentRow(document.id);
      expect(stored.status).toBe('processing');
      // New text may mean new neighbours, so that answer is owed again too.
      expect(stored.similarity_scanned_at).toBeNull();
      expect(await openItemsFor(document.id)).toHaveLength(0);
    });

    it('refuses an action that does not answer the question asked', async () => {
      const { admin, item } = await documentInReview();

      const separated = await request(app)
        .post(`/api/review/${item.id}/separate`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(separated.status).toBe(400);
      expect(separated.body.reason).toBe('action_not_applicable');
    });

    it('answers a question only once', async () => {
      const { admin, item } = await documentInReview();

      await request(app).post(`/api/review/${item.id}/accept`).set('Authorization', `Bearer ${admin.token}`);
      const again = await request(app)
        .post(`/api/review/${item.id}/dismiss`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(again.status).toBe(409);
      expect(again.body.reason).toBe('already_resolved');
    });

    it('records who answered and how', async () => {
      const { admin, document, item } = await documentInReview();

      await request(app)
        .post(`/api/review/${item.id}/dismiss`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ note: 'Beleg wird nicht benoetigt' });

      const audit = await query(
        `SELECT details FROM audit_logs WHERE action = 'review_item_resolved' AND document_id = $1;`,
        [document.id]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details).toMatchObject({ action: 'dismiss', kind: 'low_confidence' });

      const resolved = await query('SELECT * FROM review_items WHERE id = $1;', [item.id]);
      expect(resolved.rows[0]).toMatchObject({ status: 'dismissed', resolution_note: 'Beleg wird nicht benoetigt' });
      expect(resolved.rows[0].resolved_by).toBe(admin.user.id);
    });
  });

  // ---------------------------------------------------------------------
  // 5. Review state survives worker and provider restarts
  // ---------------------------------------------------------------------
  describe('review state is database state', () => {
    it('re-running extraction after a restart neither double-applies nor stacks questions', async () => {
      const document = await createTestDocument({ status: 'processing' });
      await recordProposal(document.id, 'doc_type', 'Rechnung', 0.95);
      await recordProposal(document.id, 'sender', 'Stadtwerke Musterstadt GmbH', 0.6);

      const first = await finishProcessing(document.id);
      expect(first.status).toBe('review');

      // The worker died here and came back. Everything it needs to know is
      // in the database, so it simply runs the same statements again.
      const second = await finishProcessing(document.id);
      expect(second.status).toBe('review');

      const items = await query('SELECT * FROM review_items WHERE document_id = $1;', [document.id]);
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0].status).toBe('open');
      expect(items.rows[0].detail.fields).toEqual(['sender']);

      const applied = await query(
        `SELECT field, applied_value FROM document_extractions WHERE document_id = $1 ORDER BY field;`,
        [document.id]
      );
      expect(applied.rows).toEqual([
        { field: 'doc_type', applied_value: 'Rechnung' },
        { field: 'sender', applied_value: null },
      ]);
    });

    it('holds a document in review until the last question is answered', async () => {
      const admin = await loginAsAdmin(app);
      const original = await createTestDocument({ title: 'Stromrechnung.pdf', status: 'ready' });
      await query('UPDATE documents SET ocr_text = $2 WHERE id = $1;', [original.id, INVOICE_TEXT]);

      const document = await createTestDocument({ title: 'Stromrechnung_Scan2.pdf', status: 'processing' });
      await query('UPDATE documents SET ocr_text = $2 WHERE id = $1;', [document.id, `${INVOICE_TEXT} Zweitschrift`]);
      await recordProposal(document.id, 'sender', 'Stadtwerke', 0.6);
      await finishProcessing(document.id);
      await scanDocumentForSimilarity(document.id);

      const open = await openItemsFor(document.id);
      expect(open.map((row: any) => row.kind).sort()).toEqual(['low_confidence', 'similar_document']);

      const firstAnswer = await request(app)
        .post(`/api/review/${open[0].id}/accept`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(firstAnswer.body.documentStatus).toBe('review');

      const lastAnswer = await request(app)
        .post(`/api/review/${open[1].id}/separate`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(lastAnswer.body.documentStatus).toBe('ready');
    });

    it('leaves a trashed document out of the inbox entirely', async () => {
      const admin = await loginAsAdmin(app);
      const document = await createTestDocument({ status: 'processing' });
      await recordProposal(document.id, 'sender', 'Stadtwerke', 0.6);
      await finishProcessing(document.id);
      const [item] = await openItemsFor(document.id);

      await query(`SELECT * FROM transition_document($1, 'trashed', NULL);`, [document.id]);

      const answered = await request(app)
        .post(`/api/review/${item.id}/accept`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(answered.status).toBe(409);
      expect(answered.body.reason).toBe('document_trashed');
    });
  });

  // ---------------------------------------------------------------------
  // The inbox is a document list, so it answers to the document rules
  // ---------------------------------------------------------------------
  describe('visibility', () => {
    it('keeps another persons private-space question out of an administrators inbox', async () => {
      const admin = await loginAsAdmin(app);
      const owner = await makeUser('Space Owner');
      const space = await createTestSpace({ name: 'Gesundheit', kind: 'private', ownerId: owner.id });
      const document = await createTestDocument({
        title: 'Therapiebericht.pdf',
        status: 'processing',
        spaceId: space.id,
        createdBy: owner.id,
      });
      await recordProposal(document.id, 'sender', 'Praxis Dr. Sommer', 0.6);
      await finishProcessing(document.id);

      const adminInbox = await request(app).get('/api/review').set('Authorization', `Bearer ${admin.token}`);
      expect(adminInbox.body.items).toHaveLength(0);
      expect((await request(app).get('/api/review/count').set('Authorization', `Bearer ${admin.token}`)).body)
        .toEqual({ openCount: 0 });

      const ownerInbox = await request(app).get('/api/review').set('Authorization', `Bearer ${owner.token}`);
      expect(ownerInbox.body.items).toHaveLength(1);
      expect(ownerInbox.body.items[0].documentTitle).toBe('Therapiebericht.pdf');
    });

    it('refuses an answer from somebody who may not write the document', async () => {
      const owner = await makeUser('Space Owner');
      const outsider = await makeUser('Outsider');
      const space = await createTestSpace({ name: 'Gesundheit', kind: 'private', ownerId: owner.id });
      const document = await createTestDocument({ status: 'processing', spaceId: space.id, createdBy: owner.id });
      await recordProposal(document.id, 'sender', 'Praxis Dr. Sommer', 0.6);
      await finishProcessing(document.id);
      const [item] = await openItemsFor(document.id);

      const refused = await request(app)
        .post(`/api/review/${item.id}/accept`)
        .set('Authorization', `Bearer ${outsider.token}`);

      expect(refused.status).toBe(403);
      expect(refused.body.reason).toBe('forbidden');
      expect(await openItemsFor(document.id)).toHaveLength(1);
    });

    it('names a duplicate counterpart only to somebody who may read it', async () => {
      const editor = await makeUser('Reviewer');
      const admin = await loginAsAdmin(app);

      const readable = await ingestDocument({
        stagedPath: await stage('counterpart visibility bytes'),
        source: 'watchfolder',
        idempotencyKey: `vis-a-${crypto.randomUUID()}`,
        filename: 'Kontoauszug.pdf',
        mimeType: 'application/pdf',
      });
      const restricted = await ingestDocument({
        stagedPath: await stage('counterpart visibility bytes'),
        source: 'watchfolder',
        idempotencyKey: `vis-b-${crypto.randomUUID()}`,
        filename: 'Kontoauszug (vertraulich).pdf',
        mimeType: 'application/pdf',
      });

      // The older document is the counterpart, so restrict that one and put
      // the open question on the readable one.
      const tag = await query(`INSERT INTO tags (name) VALUES ('Vertraulich') RETURNING id;`);
      await query('INSERT INTO document_tags (document_id, tag_id) VALUES ($1, $2);', [
        readable.document.id,
        tag.rows[0].id,
      ]);

      const editorInbox = await request(app).get('/api/review').set('Authorization', `Bearer ${editor.token}`);
      expect(editorInbox.body.items).toHaveLength(1);
      expect(editorInbox.body.items[0].documentId).toBe(restricted.document.id);
      expect(editorInbox.body.items[0].counterpart).toMatchObject({
        documentId: readable.document.id,
        title: null,
        redacted: true,
      });

      const adminInbox = await request(app).get('/api/review').set('Authorization', `Bearer ${admin.token}`);
      expect(adminInbox.body.items[0].counterpart).toMatchObject({
        title: 'Kontoauszug.pdf',
        redacted: false,
      });

      // Answering the question does not reveal the counterpart either.
      const answered = await request(app)
        .post(`/api/review/${editorInbox.body.items[0].id}/accept`)
        .set('Authorization', `Bearer ${editor.token}`);
      expect(answered.status).toBe(200);
      expect(answered.body.item.counterpart).toMatchObject({ title: null, redacted: true });
    });
  });
});
