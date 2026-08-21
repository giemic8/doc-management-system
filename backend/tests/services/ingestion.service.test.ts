import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query } from '../../src/database/db';
import { config } from '../../src/config';
import { closeDatabase, resetDatabase } from '../helpers/db';
import { createTestDocument } from '../helpers/documents';
import {
  ingestDocument,
  retryDocument,
  retryDurability,
  transitionDocument,
} from '../../src/services/ingestion.service';

describe('canonical ingestion lifecycle', () => {
  beforeAll(resetDatabase);

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

describe('dual-copy durability (Ticket #31)', () => {
  afterAll(closeDatabase);

  it('does not acknowledge ingestion until both independent copies are written and hash-verified', async () => {
    const stagedPath = path.join(os.tmpdir(), `durability-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(stagedPath, 'dual copy bytes');

    const { document } = await ingestDocument({
      stagedPath,
      source: 'watchfolder',
      idempotencyKey: `durable:${crypto.randomUUID()}`,
      filename: 'durable.pdf',
      mimeType: 'application/pdf',
    });

    expect(document.status).toBe('processing');
    expect(fs.existsSync(document.file_path)).toBe(true);
    expect(document.replica_file_path).toBeTruthy();
    expect(fs.existsSync(document.replica_file_path!)).toBe(true);
    expect(document.replica_verified_at).toBeTruthy();
    expect(fs.readFileSync(document.replica_file_path!, 'utf8')).toBe('dual copy bytes');
    expect(document.file_path).not.toBe(document.replica_file_path);

    fs.unlinkSync(document.file_path);
    fs.unlinkSync(document.replica_file_path!);
  });

  it('preserves the primary copy and leaves a recoverable, retryable state when the replica write fails', async () => {
    // Fault injection: point the replica root at a path nested inside a
    // regular file. No mkdir/copy can ever succeed under it, regardless of
    // OS permissions -- a deterministic, portable write failure.
    const blockerFile = path.join(os.tmpdir(), `blocker-${crypto.randomUUID()}`);
    fs.writeFileSync(blockerFile, 'not a directory');
    const originalReplicaPath = config.storageReplicaPath;
    config.storageReplicaPath = path.join(blockerFile, 'nested', 'replica-root');

    const stagedPath = path.join(os.tmpdir(), `partial-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(stagedPath, 'partially durable bytes');
    const idempotencyKey = `partial:${crypto.randomUUID()}`;

    try {
      await expect(
        ingestDocument({
          stagedPath,
          source: 'watchfolder',
          idempotencyKey,
          filename: 'partial.pdf',
          mimeType: 'application/pdf',
        })
      ).rejects.toThrow(/replica copy failed/);
    } finally {
      config.storageReplicaPath = originalReplicaPath;
    }

    const rows = await query('SELECT * FROM documents WHERE ingestion_source = $1 AND ingestion_key = $2;', [
      'watchfolder',
      idempotencyKey,
    ]);
    const failedDocument = rows.rows[0];
    expect(failedDocument.status).toBe('failed');
    expect(failedDocument.failure_reason).toMatch(/replica copy failed/);
    // The primary write happened before the replica failure and must survive it.
    expect(fs.existsSync(failedDocument.file_path)).toBe(true);
    expect(fs.readFileSync(failedDocument.file_path, 'utf8')).toBe('partially durable bytes');
    expect(failedDocument.replica_file_path).toBeNull();

    const resumed = await retryDurability(failedDocument.id);

    expect(resumed.status).toBe('processing');
    expect(resumed.replica_file_path).toBeTruthy();
    expect(fs.existsSync(resumed.replica_file_path!)).toBe(true);
    expect(fs.readFileSync(resumed.replica_file_path!, 'utf8')).toBe('partially durable bytes');

    fs.unlinkSync(resumed.file_path);
    fs.unlinkSync(resumed.replica_file_path!);
  });

  it('reuses already-durable bytes for exact-duplicate content instead of storing a third copy', async () => {
    const originalEncryptionSetting = config.storageEncryptionEnabled;
    config.storageEncryptionEnabled = false;

    const content = `duplicate content ${crypto.randomUUID()}`;
    const firstStagedPath = path.join(os.tmpdir(), `dup-a-${crypto.randomUUID()}.pdf`);
    const secondStagedPath = path.join(os.tmpdir(), `dup-b-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(firstStagedPath, content);
    fs.writeFileSync(secondStagedPath, content);

    try {
      const first = await ingestDocument({
        stagedPath: firstStagedPath,
        source: 'email',
        idempotencyKey: `dup:first:${crypto.randomUUID()}`,
        filename: 'dup-a.pdf',
        mimeType: 'application/pdf',
      });
      const second = await ingestDocument({
        stagedPath: secondStagedPath,
        source: 'email',
        idempotencyKey: `dup:second:${crypto.randomUUID()}`,
        filename: 'dup-b.pdf',
        mimeType: 'application/pdf',
      });

      expect(second.document.id).not.toBe(first.document.id);
      expect(second.document.file_path).not.toBe(first.document.file_path);
      expect(second.document.replica_file_path).toBeTruthy();

      // Same inode on both sides -- content is hardlinked, not duplicated.
      expect(fs.statSync(second.document.file_path).ino).toBe(fs.statSync(first.document.file_path).ino);
      expect(fs.statSync(second.document.replica_file_path!).ino).toBe(
        fs.statSync(first.document.replica_file_path!).ino
      );
      expect(fs.statSync(first.document.file_path).nlink).toBeGreaterThanOrEqual(2);

      fs.unlinkSync(second.document.file_path);
      fs.unlinkSync(second.document.replica_file_path!);
      fs.unlinkSync(first.document.file_path);
      fs.unlinkSync(first.document.replica_file_path!);
    } finally {
      config.storageEncryptionEnabled = originalEncryptionSetting;
    }
  });
});
