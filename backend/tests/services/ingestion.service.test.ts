import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { createTestDocument } from '../helpers/documents';
import { ingestDocument, retryDocument, transitionDocument } from '../../src/services/ingestion.service';

describe('canonical ingestion lifecycle', () => {
  beforeAll(resetDatabase);
  afterAll(closeDatabase);

  it('moves a received document to durable storage state', async () => {
    const document = await createTestDocument({ status: 'received' });

    const transitioned = await transitionDocument(document.id, 'durable');

    expect(transitioned).toMatchObject({
      id: document.id,
      status: 'durable',
      failure_reason: null,
    });
  });

  it('retries a failed document once and clears its active failure', async () => {
    const document = await createTestDocument({ status: 'received' });
    const failed = await transitionDocument(document.id, 'failed', 'OCR provider unavailable');

    expect(failed).toMatchObject({
      status: 'failed',
      failure_reason: 'OCR provider unavailable',
    });

    const retried = await retryDocument(document.id);
    const repeated = await retryDocument(document.id);

    expect(retried).toMatchObject({
      status: 'processing',
      failure_reason: null,
      processing_attempts: 1,
    });
    expect(repeated).toMatchObject({
      status: 'processing',
      failure_reason: null,
      processing_attempts: 1,
    });
  });

  it('ingests a source identity once across repeated delivery', async () => {
    const firstStagedPath = path.join(os.tmpdir(), `ingestion-${crypto.randomUUID()}.pdf`);
    const repeatedStagedPath = path.join(os.tmpdir(), `ingestion-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(firstStagedPath, 'canonical document bytes');
    fs.writeFileSync(repeatedStagedPath, 'canonical document bytes');

    const first = await ingestDocument({
      stagedPath: firstStagedPath,
      source: 'email',
      idempotencyKey: 'mailbox:42:attachment:0',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
    });
    const repeated = await ingestDocument({
      stagedPath: repeatedStagedPath,
      source: 'email',
      idempotencyKey: 'mailbox:42:attachment:0',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
    });

    expect(first.replayed).toBe(false);
    expect(first.document).toMatchObject({ status: 'processing', ingestion_source: 'email' });
    expect(fs.existsSync(first.document.file_path)).toBe(true);
    expect(repeated).toMatchObject({ replayed: true, document: { id: first.document.id } });
    expect(fs.existsSync(repeatedStagedPath)).toBe(false);

    fs.unlinkSync(first.document.file_path);
  });

  it.each(['browser', 'watchfolder', 'email'] as const)(
    'uses the canonical lifecycle for %s ingestion',
    async (source) => {
      const stagedPath = path.join(os.tmpdir(), `ingestion-${crypto.randomUUID()}.pdf`);
      fs.writeFileSync(stagedPath, `${source} document bytes`);

      const result = await ingestDocument({
        stagedPath,
        source,
        idempotencyKey: `${source}:${crypto.randomUUID()}`,
        filename: `${source}.pdf`,
        mimeType: 'application/pdf',
      });

      expect(result.document).toMatchObject({
        status: 'processing',
        ingestion_source: source,
        failure_reason: null,
        processing_attempts: 1,
      });
      fs.unlinkSync(result.document.file_path);
    }
  );

  it('rejects a transition that skips required lifecycle states', async () => {
    const document = await createTestDocument({ status: 'received' });

    await expect(transitionDocument(document.id, 'ready')).rejects.toThrow(
      'Invalid document transition: received -> ready'
    );
  });

  it('resumes failed ingestion when the source delivers the same identity again', async () => {
    const firstStagedPath = path.join(os.tmpdir(), `ingestion-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(firstStagedPath, 'recoverable document bytes');
    const first = await ingestDocument({
      stagedPath: firstStagedPath,
      source: 'watchfolder',
      idempotencyKey: 'scanner:recoverable-document',
      filename: 'recoverable.pdf',
      mimeType: 'application/pdf',
    });
    await transitionDocument(first.document.id, 'failed', 'storage temporarily unavailable');
    fs.unlinkSync(first.document.file_path);

    const repeatedStagedPath = path.join(os.tmpdir(), `ingestion-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(repeatedStagedPath, 'recoverable document bytes');
    const resumed = await ingestDocument({
      stagedPath: repeatedStagedPath,
      source: 'watchfolder',
      idempotencyKey: 'scanner:recoverable-document',
      filename: 'recoverable.pdf',
      mimeType: 'application/pdf',
    });

    expect(resumed).toMatchObject({
      replayed: false,
      document: {
        id: first.document.id,
        status: 'processing',
        failure_reason: null,
        processing_attempts: 2,
      },
    });
    expect(fs.existsSync(resumed.document.file_path)).toBe(true);
    fs.unlinkSync(resumed.document.file_path);
  });
});
