import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { query } from '../database/db';
import { config } from '../config';
import { encryptFile } from './fileEncryption.service';
import { StorageService } from './storage.service';
import { recordExactDuplicate } from './duplicateDetection.service';

export type DocumentState =
  | 'received'
  | 'durable'
  | 'processing'
  | 'review'
  | 'ready'
  | 'failed'
  | 'trashed';

export interface IngestionDocument {
  id: string;
  title: string;
  space_id?: string | null;
  status: DocumentState;
  failure_reason: string | null;
  processing_attempts: number;
  file_path: string;
  replica_file_path: string | null;
  replica_verified_at: string | null;
  file_hash: string;
  is_encrypted: boolean;
  encryption_iv: string | null;
  encryption_auth_tag: string | null;
  ingestion_source: IngestionSource | null;
  ingestion_key: string | null;
}

export type IngestionSource = 'browser' | 'watchfolder' | 'email';

export interface IngestDocumentInput {
  stagedPath: string;
  source: IngestionSource;
  idempotencyKey: string;
  filename: string;
  mimeType: string;
  createdBy?: string;
  sender?: string;
  /**
   * Ticket #34 -- the family space this delivery belongs in. `undefined`
   * means the common area, which is where watchfolder and email imports
   * land: an unattended source has nobody to decide privacy for.
   */
  spaceId?: string | null;
}

export interface IngestDocumentResult {
  document: IngestionDocument;
  replayed: boolean;
}

export async function transitionDocument(
  documentId: string,
  toState: DocumentState,
  reason?: string
): Promise<IngestionDocument> {
  const result = await query(
    'SELECT * FROM transition_document($1::uuid, $2::varchar, $3::text);',
    [documentId, toState, reason ?? null]
  );
  return result.rows[0] as IngestionDocument;
}

export async function retryDocument(documentId: string): Promise<IngestionDocument> {
  return transitionDocument(documentId, 'processing');
}

/**
 * Thrown when the primary copy is durable on disk but the second
 * independent copy could not be written and verified. The primary file
 * and the document row are left in place (status 'failed') so a caller
 * can fix just the missing replica via retryDurability instead of
 * re-ingesting the source from scratch.
 */
export class ReplicaDurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaDurabilityError';
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error: any) {
    if (error.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.unlink(sourcePath);
  }
}

/**
 * Writes the second independent copy of an already-durable primary file
 * and verifies it byte-for-byte before returning. Any failure here must
 * NOT touch the primary -- the caller keeps it and the document stays
 * retryable via retryDurability.
 */
async function commitReplica(documentId: string, primaryPath: string, replicaPath: string): Promise<void> {
  const storedHash = await StorageService.calculateFileHash(primaryPath);
  try {
    await StorageService.writeVerifiedCopy(primaryPath, replicaPath, storedHash);
  } catch (error: any) {
    throw new ReplicaDurabilityError(
      `Primary copy is durable at ${primaryPath}, but the replica copy failed: ${error.message}`
    );
  }
  await query(
    `UPDATE documents SET replica_file_path = $2, replica_verified_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [documentId, replicaPath]
  );
}

/** An exact-content match that is already durable (both copies verified) and safe to hardlink instead of re-copying. */
async function findDurableDuplicate(fileHash: string, excludeDocumentId?: string): Promise<IngestionDocument | undefined> {
  if (config.storageEncryptionEnabled) return undefined; // per-file random IV means ciphertext copies can't be shared safely.
  const result = await query(
    `SELECT * FROM documents
     WHERE file_hash = $1 AND is_encrypted = false AND replica_verified_at IS NOT NULL
       AND id != COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY created_at ASC
     LIMIT 1;`,
    [fileHash, excludeDocumentId ?? null]
  );
  const candidate = result.rows[0] as IngestionDocument | undefined;
  if (!candidate) return undefined;
  if (!fs.existsSync(candidate.file_path) || !candidate.replica_file_path || !fs.existsSync(candidate.replica_file_path)) {
    return undefined; // stale reference -- fall back to a normal dual write.
  }
  return candidate;
}

/**
 * Retries just the missing replica copy for a document whose primary
 * copy is already durable but which failed before the replica could be
 * written and verified (see ReplicaDurabilityError). Does not touch the
 * primary and does not require the original source bytes.
 */
export async function retryDurability(documentId: string): Promise<IngestionDocument> {
  const result = await query('SELECT * FROM documents WHERE id = $1;', [documentId]);
  const document = result.rows[0] as IngestionDocument | undefined;
  if (!document) {
    throw new Error(`Document ${documentId} not found`);
  }
  if (!fs.existsSync(document.file_path)) {
    throw new Error(`Primary copy missing for document ${documentId} at ${document.file_path}; durability cannot be resumed`);
  }
  if (!document.replica_file_path || !fs.existsSync(document.replica_file_path)) {
    const replicaPath = StorageService.getReplicaFilePath(path.basename(document.file_path));
    await commitReplica(documentId, document.file_path, replicaPath);
  }
  if (document.status === 'failed') {
    await transitionDocument(documentId, 'received');
  }
  await transitionDocument(documentId, 'durable');
  return transitionDocument(documentId, 'processing');
}

export async function ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult> {
  const fileHash = await StorageService.calculateFileHash(input.stagedPath);
  const stats = await fs.promises.stat(input.stagedPath);
  const safeFilename = path.basename(input.filename).slice(-500);
  const storedFilename = `${Date.now()}_${crypto.randomUUID()}_${safeFilename}`;
  const targetPath = StorageService.getOriginalFilePath(storedFilename);
  const replicaTargetPath = StorageService.getReplicaFilePath(storedFilename);

  let documentId: string | undefined;
  try {
    const inserted = await query(
      `INSERT INTO documents (
         title, original_filename, file_path, file_size, mime_type, file_hash, status,
         created_by, sender, ingestion_source, ingestion_key, space_id
       ) VALUES ($1, $1, $2, $3, $4, $5, 'received', $6, $7, $8, $9, $10)
       ON CONFLICT (ingestion_source, ingestion_key)
         WHERE ingestion_source IS NOT NULL AND ingestion_key IS NOT NULL
       DO NOTHING
       RETURNING *;`,
      [
        safeFilename,
        targetPath,
        stats.size,
        input.mimeType,
        fileHash,
        input.createdBy ?? null,
        input.sender ?? null,
        input.source,
        input.idempotencyKey,
        input.spaceId ?? null,
      ]
    );

    if (inserted.rows.length === 0) {
      const existing = await query(
        'SELECT * FROM documents WHERE ingestion_source = $1 AND ingestion_key = $2;',
        [input.source, input.idempotencyKey]
      );
      const existingDocument = existing.rows[0] as IngestionDocument | undefined;
      if (!existingDocument) {
        throw new Error('Ingestion identity disappeared after conflict');
      }
      if (existingDocument.status !== 'failed') {
        await removeIfPresent(input.stagedPath);
        return { document: existingDocument, replayed: true };
      }

      documentId = existingDocument.id;
      // A previous attempt may have left a durable primary (and possibly a
      // verified replica) behind under the old target path. It's being
      // replaced by a fresh ingest below, so it would otherwise leak.
      await removeIfPresent(existingDocument.file_path);
      if (existingDocument.replica_file_path) {
        await removeIfPresent(existingDocument.replica_file_path);
      }
      await query(
        `UPDATE documents
         SET title = $2,
             original_filename = $2,
             file_path = $3,
             file_size = $4,
             mime_type = $5,
             file_hash = $6,
             created_by = COALESCE($7, created_by),
             sender = COALESCE($8, sender),
             -- Ticket #34: a retry keeps whatever space the first attempt
             -- chose unless the caller names one, so re-delivering a failed
             -- import can never quietly move a document out of its space.
             space_id = COALESCE($9, space_id),
             is_encrypted = false,
             encryption_iv = NULL,
             encryption_auth_tag = NULL,
             replica_file_path = NULL,
             replica_verified_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1;`,
        [
          documentId,
          safeFilename,
          targetPath,
          stats.size,
          input.mimeType,
          fileHash,
          input.createdBy ?? null,
          input.sender ?? null,
          input.spaceId ?? null,
        ]
      );
      await transitionDocument(documentId, 'received');
    } else {
      documentId = inserted.rows[0].id as string;
      await query(
        `INSERT INTO document_state_transitions (document_id, from_state, to_state)
         VALUES ($1, NULL, 'received');`,
        [documentId]
      );
    }

    const duplicate = await findDurableDuplicate(fileHash, documentId);
    if (duplicate) {
      // Exact content already has two verified copies on disk -- link into
      // both instead of writing (and storing) the bytes a third time.
      await StorageService.linkExistingCopy(duplicate.file_path, targetPath);
      await StorageService.linkExistingCopy(duplicate.replica_file_path!, replicaTargetPath);
      await removeIfPresent(input.stagedPath);
      await query(
        `UPDATE documents
         SET replica_file_path = $2, replica_verified_at = CURRENT_TIMESTAMP
         WHERE id = $1;`,
        [documentId, replicaTargetPath]
      );
    } else {
      if (config.storageEncryptionEnabled) {
        const encrypted = await encryptFile(input.stagedPath, targetPath, config.storageEncryptionKey);
        await removeIfPresent(input.stagedPath);
        await query(
          `UPDATE documents
           SET is_encrypted = true, encryption_iv = $2, encryption_auth_tag = $3
           WHERE id = $1;`,
          [documentId, encrypted.iv, encrypted.authTag]
        );
      } else {
        await moveFile(input.stagedPath, targetPath);
      }

      // Primary is durable at this point; a replica failure below must not
      // discard it -- only the transition to 'durable' is still pending.
      await commitReplica(documentId, targetPath, replicaTargetPath);
    }

    // Ticket #35 -- the hash is already in hand, so an exact duplicate is
    // known here and recorded as a question for a reviewer. The bytes were
    // not written a second time (the branch above hardlinks into the
    // existing verified copies), and nothing is merged: the household is
    // told it already has this file, and decides.
    await recordExactDuplicate(documentId, fileHash);

    await transitionDocument(documentId, 'durable');
    const processing = await transitionDocument(documentId, 'processing');
    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details)
       VALUES ($1, $2, $3, $4);`,
      [
        documentId,
        input.createdBy ?? null,
        input.source === 'browser' ? 'upload' : 'ingest',
        JSON.stringify({ source: input.source, filename: safeFilename, size: stats.size }),
      ]
    );
    return { document: processing, replayed: false };
  } catch (error: any) {
    await removeIfPresent(input.stagedPath);
    const isReplicaFailure = error instanceof ReplicaDurabilityError;
    if (!isReplicaFailure) {
      // Anything short of a verified replica isn't durable yet -- clean up
      // whatever landed at targetPath (partial write or nothing at all).
      // A ReplicaDurabilityError is the one case where targetPath already
      // holds a fully verified primary copy that must be preserved.
      await removeIfPresent(targetPath);
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (documentId) {
      try {
        await transitionDocument(documentId, 'failed', reason);
      } catch {
        // Preserve original ingestion error when database state cannot be updated.
      }
    }
    throw error;
  }
}
