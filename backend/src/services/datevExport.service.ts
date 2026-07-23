import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import archiver from 'archiver';
import { decryptFile } from './fileEncryption.service';

export interface DatevExportRow {
  id: string;
  document_date: string | Date | null;
  amount: number | string | null;
  currency: string | null;
  tax_id: string | null;
  sender: string | null;
}

export interface DatevExportDocument extends DatevExportRow {
  file_path: string;
  original_filename: string;
  is_encrypted?: boolean;
  encryption_iv?: string | null;
  encryption_auth_tag?: string | null;
}

const CSV_HEADER = 'Belegdatum;Betrag;Waehrung;Steuer-ID;Empfaenger;Belegnummer';

function formatDate(value: string | Date | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

function formatAmount(value: number | string | null): string {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '';
  return num.toFixed(2).replace('.', ',');
}

function csvField(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Builds a simplified DATEV-style "Buchungsstapel" CSV (semicolon-delimited,
 * German decimal-comma convention). Pure function -- no DB/IO access -- so
 * it is easily unit-testable.
 */
export function buildDatevCsv(documents: DatevExportRow[]): string {
  const rows = documents.map((doc) => {
    return [
      formatDate(doc.document_date),
      formatAmount(doc.amount),
      csvField(doc.currency),
      csvField(doc.tax_id),
      csvField(doc.sender),
      csvField(doc.id),
    ].join(';');
  });

  return [CSV_HEADER, ...rows].join('\n');
}

/**
 * Builds the DATEV tax advisor export ZIP: a `datev-export.csv` at the root
 * plus each document's original PDF (under `documents/`). Encrypted
 * originals are decrypted to a temp file before being added to the archive
 * so no encrypted bytes ever end up in the export package.
 */
export function buildDatevExportZip(destPath: string, documents: DatevExportDocument[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const tempFiles: string[] = [];

    output.on('close', () => {
      for (const tmp of tempFiles) {
        fs.unlink(tmp, () => {});
      }
      resolve();
    });
    archive.on('error', (err) => {
      for (const tmp of tempFiles) {
        fs.unlink(tmp, () => {});
      }
      reject(err);
    });
    archive.pipe(output);

    const csv = buildDatevCsv(documents);
    archive.append(csv, { name: 'datev-export.csv' });

    const addFiles = async () => {
      for (const doc of documents) {
        if (!doc.file_path || !fs.existsSync(doc.file_path)) continue;

        if (doc.is_encrypted && doc.encryption_iv && doc.encryption_auth_tag) {
          const tmpPath = path.join(os.tmpdir(), `datev-decrypt-${crypto.randomUUID()}.pdf`);
          try {
            await decryptFile(doc.file_path, tmpPath, doc.encryption_iv, doc.encryption_auth_tag);
            tempFiles.push(tmpPath);
            archive.file(tmpPath, { name: `documents/${doc.original_filename}` });
          } catch (err) {
            // Skip documents that fail to decrypt rather than failing the
            // whole export.
            continue;
          }
        } else {
          archive.file(doc.file_path, { name: `documents/${doc.original_filename}` });
        }
      }

      archive.finalize();
    };

    addFiles().catch(reject);
  });
}
