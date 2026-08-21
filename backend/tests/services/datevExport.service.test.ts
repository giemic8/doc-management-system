import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { buildDatevCsv, buildDatevExportZip, DatevExportRow } from '../../src/services/datevExport.service';

describe('buildDatevCsv', () => {
  it('produces the correct header row', () => {
    const csv = buildDatevCsv([]);
    const [header] = csv.split('\n');
    expect(header).toBe('Belegdatum;Betrag;Waehrung;Steuer-ID;Empfaenger;Belegnummer');
  });

  it('formats the invoice date as DD.MM.YYYY', () => {
    const row: DatevExportRow = {
      id: 'doc-1',
      document_date: '2024-03-05T00:00:00Z',
      amount: 100,
      currency: 'EUR',
      tax_id: 'DE123456789',
      sender: 'Acme GmbH',
    };
    const csv = buildDatevCsv([row]);
    const [, dataRow] = csv.split('\n');
    expect(dataRow.split(';')[0]).toBe('05.03.2024');
  });

  it('formats the amount with a comma as decimal separator', () => {
    const row: DatevExportRow = {
      id: 'doc-1',
      document_date: '2024-01-01',
      amount: 1499,
      currency: 'EUR',
      tax_id: 'DE123456789',
      sender: 'Acme GmbH',
    };
    const csv = buildDatevCsv([row]);
    const [, dataRow] = csv.split('\n');
    expect(dataRow.split(';')[1]).toBe('1499,00');
  });

  it('formats amounts with cents correctly', () => {
    const row: DatevExportRow = {
      id: 'doc-1',
      document_date: '2024-01-01',
      amount: 42.5,
      currency: 'EUR',
      tax_id: 'DE123456789',
      sender: 'Acme GmbH',
    };
    const csv = buildDatevCsv([row]);
    const [, dataRow] = csv.split('\n');
    expect(dataRow.split(';')[1]).toBe('42,50');
  });

  it('leaves the tax ID field empty (not "null") when missing', () => {
    const row: DatevExportRow = {
      id: 'doc-1',
      document_date: '2024-01-01',
      amount: 100,
      currency: 'EUR',
      tax_id: null,
      sender: 'Acme GmbH',
    };
    const csv = buildDatevCsv([row]);
    const [, dataRow] = csv.split('\n');
    expect(dataRow.split(';')[3]).toBe('');
    expect(dataRow).not.toContain('null');
  });

  it('handles multiple rows', () => {
    const rows: DatevExportRow[] = [
      { id: 'doc-1', document_date: '2024-01-01', amount: 100, currency: 'EUR', tax_id: 'DE1', sender: 'A GmbH' },
      { id: 'doc-2', document_date: '2024-02-15', amount: 250.75, currency: 'EUR', tax_id: null, sender: 'B GmbH' },
    ];
    const csv = buildDatevCsv(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toBe('01.01.2024;100,00;EUR;DE1;A GmbH;doc-1');
    expect(lines[2]).toBe('15.02.2024;250,75;EUR;;B GmbH;doc-2');
  });
});

describe('buildDatevExportZip cleanup', () => {
  it('fails incomplete exports and removes plaintext temp files after decryption errors', async () => {
    const sourcePath = path.join(os.tmpdir(), `datev-source-${crypto.randomUUID()}.bin`);
    const destinationPath = path.join(os.tmpdir(), `datev-export-${crypto.randomUUID()}.zip`);
    fs.writeFileSync(sourcePath, Buffer.from('not valid encrypted content'));
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('datev-decrypt-')));

    try {
      await expect(
        buildDatevExportZip(destinationPath, [
          {
            id: 'doc-1',
            document_date: '2026-01-01',
            amount: 10,
            currency: 'EUR',
            tax_id: null,
            sender: 'Vendor',
            file_path: sourcePath,
            original_filename: 'invoice.pdf',
            is_encrypted: true,
            encryption_iv: '00'.repeat(12),
            encryption_auth_tag: '00'.repeat(16),
          },
        ])
      ).rejects.toBeTruthy();

      const leaked = fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith('datev-decrypt-') && !before.has(name));
      expect(leaked).toEqual([]);
    } finally {
      fs.rmSync(sourcePath, { force: true });
      fs.rmSync(destinationPath, { force: true });
    }
  });
});
