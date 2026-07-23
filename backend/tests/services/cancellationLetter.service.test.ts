import { describe, it, expect } from 'vitest';
import { buildCancellationLetterPdf } from '../../src/services/cancellationLetter.service';

describe('buildCancellationLetterPdf', () => {
  it('returns a non-empty PDF buffer with all fields provided', async () => {
    const pdf = await buildCancellationLetterPdf({
      vendorName: 'Fitness First GmbH',
      vendorAddress: 'Musterstraße 1\n10115 Berlin',
      customerNumber: 'CU-12345',
      contractTitle: 'Mitgliedschaftsvertrag',
      cancellationDeadline: '2026-09-01',
      senderName: 'Max Mustermann',
    });

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 4).toString('utf-8')).toBe('%PDF');
  });

  it('does not throw when optional fields are omitted', async () => {
    const pdf = await buildCancellationLetterPdf({
      vendorName: 'Some Vendor',
      contractTitle: 'Vertrag ohne Details',
    });

    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 4).toString('utf-8')).toBe('%PDF');
  });
});
