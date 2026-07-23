import { describe, it, expect } from 'vitest';
import { isRetentionLocked, calculateRetentionExpiry } from '../../src/services/retention.service';

describe('calculateRetentionExpiry', () => {
  it('adds N years to the given start date', () => {
    const expiry = calculateRetentionExpiry(new Date('2024-01-15'), 10);
    expect(expiry.getUTCFullYear()).toBe(2034);
    expect(expiry.getUTCMonth()).toBe(0);
    expect(expiry.getUTCDate()).toBe(15);
  });
});

describe('isRetentionLocked', () => {
  it('is locked when the retention expiry date is in the future', () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    expect(isRetentionLocked({ retention_until: futureExpiry, legal_hold: false })).toBe(true);
  });

  it('is not locked when the retention expiry date has passed', () => {
    const pastExpiry = new Date(Date.now() - 1000 * 60 * 60 * 24);
    expect(isRetentionLocked({ retention_until: pastExpiry, legal_hold: false })).toBe(false);
  });

  it('is not locked when there is no retention date set', () => {
    expect(isRetentionLocked({ retention_until: null, legal_hold: false })).toBe(false);
  });

  it('is locked when legal_hold is true, regardless of the retention date', () => {
    const pastExpiry = new Date(Date.now() - 1000 * 60 * 60 * 24);
    expect(isRetentionLocked({ retention_until: pastExpiry, legal_hold: true })).toBe(true);
    expect(isRetentionLocked({ retention_until: null, legal_hold: true })).toBe(true);
  });
});
