import { ParsedMail, Attachment } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query } from '../database/db';
import { StorageService } from './storage.service';
import { addDocumentProcessingJob } from './queue.service';
import crypto from 'crypto';
import fs from 'fs';

const IMPORTABLE_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
];

export interface ImportableAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Filters a parsed email's attachments down to document-like types (PDF/images). */
export function extractImportableAttachments(mail: ParsedMail): ImportableAttachment[] {
  const attachments: Attachment[] = mail.attachments || [];
  return attachments
    .filter((a) => IMPORTABLE_MIME_TYPES.includes(a.contentType))
    .map((a) => ({ filename: a.filename || 'attachment', contentType: a.contentType, content: a.content }));
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface ImportResult {
  emailsScanned: number;
  documentsImported: number;
  errors: string[];
}

/**
 * Polls the configured mailbox for unseen messages, extracts PDF/image
 * attachments, ingests each as a new document (tagged Source: Email,
 * sender stored as metadata), then marks the message as seen/moves it to
 * an "Archived" mailbox folder so it isn't re-imported next poll.
 */
export async function pollMailbox(imapConfig: ImapConfig, importedBy?: string): Promise<ImportResult> {
  const result: ImportResult = { emailsScanned: 0, documentsImported: 0, errors: [] };

  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: imapConfig.secure,
    auth: { user: imapConfig.user, pass: imapConfig.password },
    logger: false,
  });

  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseenUids = await client.search({ seen: false });
      const uidList: number[] = Array.isArray(unseenUids) ? unseenUids : [];
      result.emailsScanned = uidList.length;

      for (const uid of uidList) {
        try {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message || !message.source) continue;

          const parsed = await simpleParser(message.source);
          const attachments = extractImportableAttachments(parsed);
          const senderEmail = parsed.from?.value?.[0]?.address || 'unknown@unknown';

          for (const attachment of attachments) {
            const fileHash = crypto.createHash('sha256').update(attachment.content).digest('hex');
            const targetPath = StorageService.getOriginalFilePath(`${Date.now()}_${attachment.filename}`);
            fs.writeFileSync(targetPath, attachment.content);

            const dbResult = await query(
              `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, sender, created_by)
               VALUES ($1, $1, $2, $3, $4, $5, 'processing', $6, $7)
               RETURNING *;`,
              [attachment.filename, targetPath, attachment.content.length, attachment.contentType, fileHash, senderEmail, importedBy || null]
            );
            const doc = dbResult.rows[0];

            await query(`INSERT INTO tags (name) VALUES ('Source: Email') ON CONFLICT (name) DO NOTHING;`);
            await query(
              `INSERT INTO document_tags (document_id, tag_id) SELECT $1, id FROM tags WHERE name = 'Source: Email' ON CONFLICT DO NOTHING;`,
              [doc.id]
            );

            await addDocumentProcessingJob(doc.id, targetPath);
            result.documentsImported++;
          }

          // Mark seen and move to Archived so it isn't re-imported.
          await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
          try {
            await client.messageMove({ uid: String(uid) }, 'Archived', { uid: true });
          } catch {
            // "Archived" folder may not exist on every provider; not fatal --
            // the \Seen flag alone prevents re-import on the next poll.
          }
        } catch (err: any) {
          result.errors.push(`UID ${uid}: ${err.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return result;
}
