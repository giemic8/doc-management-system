import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { extractImportableAttachments } from '../../src/services/emailImport.service';

async function buildTestEmail(opts: {
  from?: string;
  subject?: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}): Promise<Buffer> {
  const boundary = '----test-boundary----';
  const parts = opts.attachments.map((att) => {
    return [
      `--${boundary}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      att.content.toString('base64'),
      '',
    ].join('\r\n');
  });

  const raw = [
    `From: ${opts.from || 'sender@example.com'}`,
    `To: invoices@mydomain.com`,
    `Subject: ${opts.subject || 'Test Email'}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'This is the email body.',
    '',
    ...parts,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(raw);
}

describe('extractImportableAttachments', () => {
  it('extracts PDF attachments from a parsed email', async () => {
    const raw = await buildTestEmail({
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 fake') }],
    });
    const parsed = await simpleParser(raw);

    const attachments = extractImportableAttachments(parsed);

    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('invoice.pdf');
    expect(attachments[0].contentType).toBe('application/pdf');
  });

  it('extracts image attachments (png/jpg)', async () => {
    const raw = await buildTestEmail({
      attachments: [{ filename: 'receipt.png', contentType: 'image/png', content: Buffer.from('fake-png-bytes') }],
    });
    const parsed = await simpleParser(raw);

    const attachments = extractImportableAttachments(parsed);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('receipt.png');
  });

  it('ignores non-document attachments (e.g. .exe)', async () => {
    const raw = await buildTestEmail({
      attachments: [{ filename: 'installer.exe', contentType: 'application/x-msdownload', content: Buffer.from('MZ') }],
    });
    const parsed = await simpleParser(raw);

    const attachments = extractImportableAttachments(parsed);
    expect(attachments).toHaveLength(0);
  });

  it('extracts multiple valid attachments, skipping invalid ones', async () => {
    const raw = await buildTestEmail({
      attachments: [
        { filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') },
        { filename: 'virus.exe', contentType: 'application/x-msdownload', content: Buffer.from('MZ') },
        { filename: 'scan.jpg', contentType: 'image/jpeg', content: Buffer.from('jpgbytes') },
      ],
    });
    const parsed = await simpleParser(raw);

    const attachments = extractImportableAttachments(parsed);
    expect(attachments.map((a) => a.filename).sort()).toEqual(['invoice.pdf', 'scan.jpg']);
  });

  it('returns an empty array for an email with no attachments', async () => {
    const raw = await buildTestEmail({ attachments: [] });
    const parsed = await simpleParser(raw);

    expect(extractImportableAttachments(parsed)).toEqual([]);
  });
});
