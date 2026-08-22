import { query } from '../../src/database/db';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/** Creates a real N-page PDF on disk and returns its bytes + path. */
export async function makeTestPdfFile(pageCount: number): Promise<{ filePath: string; bytes: Buffer }> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`Page ${i + 1}`, { x: 10, y: 100 });
  }
  const bytes = Buffer.from(await doc.save());
  const filePath = path.join(os.tmpdir(), `test-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(filePath, bytes);
  return { filePath, bytes };
}

/** Inserts a document row directly (bypassing upload/OCR) for test setup. */
export async function createTestDocument(overrides?: {
  filePath?: string;
  title?: string;
  createdBy?: string;
  status?: string;
  /** Ticket #34 -- file the document into a family space instead of the common area. */
  spaceId?: string | null;
}) {
  const { filePath, bytes } = overrides?.filePath
    ? { filePath: overrides.filePath, bytes: fs.readFileSync(overrides.filePath) }
    : await makeTestPdfFile(3);

  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const title = overrides?.title ?? 'Test Document.pdf';

  const res = await query(
    `INSERT INTO documents (title, original_filename, file_path, file_size, mime_type, file_hash, status, created_by, space_id)
     VALUES ($1, $1, $2, $3, 'application/pdf', $4, $5, $6, $7)
     RETURNING *;`,
    [
      title,
      filePath,
      bytes.length,
      fileHash,
      overrides?.status ?? 'ready',
      overrides?.createdBy ?? null,
      overrides?.spaceId ?? null,
    ]
  );

  return res.rows[0];
}

/**
 * Ticket #34 -- creates a space directly (bypassing the routes) with its
 * owner already recorded as a member, matching what createSpace does.
 */
export async function createTestSpace(overrides: {
  name?: string;
  kind?: 'private' | 'shared';
  ownerId: string;
}) {
  const name = overrides.name ?? `Space ${crypto.randomUUID().slice(0, 8)}`;
  const kind = overrides.kind ?? 'private';

  const res = await query(`INSERT INTO spaces (name, kind, owner_id) VALUES ($1, $2, $3) RETURNING *;`, [
    name,
    kind,
    overrides.ownerId,
  ]);
  const space = res.rows[0];

  await query(
    `INSERT INTO space_members (space_id, user_id, can_write, can_delete, added_by)
     VALUES ($1, $2, true, true, $2);`,
    [space.id, overrides.ownerId]
  );

  return space;
}
