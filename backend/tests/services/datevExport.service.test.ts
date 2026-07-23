import { describe, it, expect } from 'vitest';
import { buildDatevCsv, DatevExportRow } from '../../src/services/datevExport.service';

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
