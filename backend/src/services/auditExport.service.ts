import crypto from 'crypto';
import fs from 'fs';
import archiver from 'archiver';
import { config } from '../config';

export function signAuditHistory(auditEntries: any[], secret: string = config.jwtSecret): string {
  const serialized = JSON.stringify(auditEntries);
  return crypto.createHmac('sha256', secret).update(serialized).digest('hex');
}

export function verifyAuditHistorySignature(auditEntries: any[], secret: string, signature: string): boolean {
  const expected = signAuditHistory(auditEntries, secret);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export interface AuditExportDocument {
  id: string;
  file_path: string;
  original_filename: string;
  file_hash: string;
}

/**
 * Builds a GoBD-style audit export ZIP: each document's original file
 * (under `documents/`), a metadata.json describing every included
 * document plus its SHA-256 checksum, and a signed audit-history.json
 * (HMAC-signed so tampering after export is detectable).
 */
export function buildAuditExportZip(
  destPath: string,
  documents: AuditExportDocument[],
  auditHistory: any[],
  secret: string = config.jwtSecret
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const metadata = documents.map((doc) => ({
      id: doc.id,
      original_filename: doc.original_filename,
      sha256: doc.file_hash,
    }));
    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });

    const signature = signAuditHistory(auditHistory, secret);
    archive.append(JSON.stringify({ entries: auditHistory, signature }, null, 2), { name: 'audit-history.json' });

    for (const doc of documents) {
      if (fs.existsSync(doc.file_path)) {
        archive.file(doc.file_path, { name: `documents/${doc.original_filename}` });
      }
    }

    archive.finalize();
  });
}
