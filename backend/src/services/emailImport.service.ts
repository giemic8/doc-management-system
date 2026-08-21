import { ParsedMail, Attachment } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { query } from '../database/db';
import { ingestDocument } from './ingestion.service';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

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

          for (const [attachmentIndex, attachment] of attachments.entries()) {
            const stagedPath = path.join(os.tmpdir(), `email-${crypto.randomUUID()}`);
            await fs.promises.writeFile(stagedPath, attachment.content);
            const { document: doc, replayed } = await ingestDocument({
              stagedPath,
              source: 'email',
              idempotencyKey: `${imapConfig.user}:${uid}:${attachmentIndex}`,
              filename: attachment.filename,
              mimeType: attachment.contentType,
              sender: senderEmail,
              createdBy: importedBy,
            });

            await query(`INSERT INTO tags (name) VALUES ('Source: Email') ON CONFLICT (name) DO NOTHING;`);
            await query(
              `INSERT INTO document_tags (document_id, tag_id) SELECT $1, id FROM tags WHERE name = 'Source: Email' ON CONFLICT DO NOTHING;`,
              [doc.id]
            );

            if (!replayed) result.documentsImported++;
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
