import { describe, it, expect } from 'vitest';
import { buildSepaEpcPayload } from '../../src/services/sepaQr.service';

describe('buildSepaEpcPayload', () => {
  it('builds a valid EPC069-12 payload with all required lines in order', () => {
    const payload = buildSepaEpcPayload({
      receiverName: 'Dell Technologies GmbH',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      amount: 1499.0,
      reference: 'RE-2026-982341',
    });

    const lines = payload.split('\n');
    expect(lines[0]).toBe('BCD');
    expect(lines[1]).toBe('002');
    expect(lines[2]).toBe('1');
    expect(lines[3]).toBe('SCT');
    expect(lines[4]).toBe('COBADEFFXXX');
    expect(lines[5]).toBe('Dell Technologies GmbH');
    expect(lines[6]).toBe('DE89370400440532013000');
    expect(lines[7]).toBe('EUR1499.00');
    expect(lines[9]).toBe('RE-2026-982341');
  });

  it('omits the BIC line content but keeps its position when BIC is not provided', () => {
    const payload = buildSepaEpcPayload({
      receiverName: 'Vendor GmbH',
      iban: 'DE89370400440532013000',
      amount: 50,
    });
    const lines = payload.split('\n');
    expect(lines[4]).toBe(''); // BIC line present but empty
  });

  it('formats the amount with exactly two decimal places', () => {
    const payload = buildSepaEpcPayload({ receiverName: 'X', iban: 'DE89370400440532013000', amount: 10 });
    expect(payload).toContain('EUR10.00');
  });

  it('throws when the receiver name exceeds 70 characters', () => {
    expect(() =>
      buildSepaEpcPayload({ receiverName: 'A'.repeat(71), iban: 'DE89370400440532013000', amount: 1 })
    ).toThrow();
  });

  it('throws when the IBAN is missing', () => {
    expect(() => buildSepaEpcPayload({ receiverName: 'X', iban: '', amount: 1 })).toThrow();
  });

  it('throws when the amount is not positive', () => {
    expect(() => buildSepaEpcPayload({ receiverName: 'X', iban: 'DE89370400440532013000', amount: 0 })).toThrow();
    expect(() => buildSepaEpcPayload({ receiverName: 'X', iban: 'DE89370400440532013000', amount: -5 })).toThrow();
  });

  it('truncates a remittance reference longer than 140 characters', () => {
    const longRef = 'R'.repeat(200);
    const payload = buildSepaEpcPayload({ receiverName: 'X', iban: 'DE89370400440532013000', amount: 1, reference: longRef });
    const lines = payload.split('\n');
    expect(lines[9].length).toBeLessThanOrEqual(140);
  });
});
