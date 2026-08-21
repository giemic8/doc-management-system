import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { query } from '../database/db';
import { config } from '../config';
import { encryptFile } from './fileEncryption.service';
import { StorageService } from './storage.service';

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
  status: DocumentState;
  failure_reason: string | null;
  processing_attempts: number;
  file_path: string;
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

export async function ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult> {
  const fileHash = await StorageService.calculateFileHash(input.stagedPath);
  const stats = await fs.promises.stat(input.stagedPath);
  const safeFilename = path.basename(input.filename).slice(-500);
  const targetPath = StorageService.getOriginalFilePath(
    `${Date.now()}_${crypto.randomUUID()}_${safeFilename}`
  );

  let documentId: string | undefined;
  try {
    const inserted = await query(
      `INSERT INTO documents (
         title, original_filename, file_path, file_size, mime_type, file_hash, status,
         created_by, sender, ingestion_source, ingestion_key
       ) VALUES ($1, $1, $2, $3, $4, $5, 'received', $6, $7, $8, $9)
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
             is_encrypted = false,
             encryption_iv = NULL,
             encryption_auth_tag = NULL,
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
    await removeIfPresent(targetPath);
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
