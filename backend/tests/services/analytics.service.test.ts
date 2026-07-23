import { describe, it, expect } from 'vitest';
import {
  buildMonthlyBreakdown,
  buildTopVendors,
  detectRecurringSubscriptions,
  AnalyticsDoc,
} from '../../src/services/analytics.service';

function doc(overrides: Partial<AnalyticsDoc> & { id: string }): AnalyticsDoc {
  return {
    id: overrides.id,
    sender: overrides.sender ?? null,
    document_date: overrides.document_date ?? null,
    amount: overrides.amount ?? null,
    currency: overrides.currency ?? 'EUR',
  };
}

describe('buildMonthlyBreakdown', () => {
  it('groups by YYYY-MM and sums amounts, sorted ascending', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', document_date: '2026-03-15', amount: 100 }),
      doc({ id: '2', document_date: '2026-01-01', amount: 50 }),
      doc({ id: '3', document_date: '2026-01-20', amount: 25 }),
      doc({ id: '4', document_date: '2026-03-20', amount: 200.5 }),
    ];

    const result = buildMonthlyBreakdown(docs);

    expect(result).toEqual([
      { month: '2026-01', total: 75, count: 2 },
      { month: '2026-03', total: 300.5, count: 2 },
    ]);
  });

  it('ignores documents without a parseable document_date', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', document_date: null, amount: 100 }),
      doc({ id: '2', document_date: '2026-02-01', amount: 50 }),
    ];

    const result = buildMonthlyBreakdown(docs);
    expect(result).toEqual([{ month: '2026-02', total: 50, count: 1 }]);
  });

  it('handles string amounts', () => {
    const docs: AnalyticsDoc[] = [doc({ id: '1', document_date: '2026-05-01', amount: '19.99' })];
    const result = buildMonthlyBreakdown(docs);
    expect(result).toEqual([{ month: '2026-05', total: 19.99, count: 1 }]);
  });
});

describe('buildTopVendors', () => {
  it('groups by sender, sums total and counts, sorted descending by total', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'Dell', amount: 1000 }),
      doc({ id: '2', sender: 'Netflix', amount: 15 }),
      doc({ id: '3', sender: 'Dell', amount: 500 }),
      doc({ id: '4', sender: 'Netflix', amount: 15 }),
    ];

    const result = buildTopVendors(docs);

    expect(result).toEqual([
      { sender: 'Dell', total: 1500, count: 2 },
      { sender: 'Netflix', total: 30, count: 2 },
    ]);
  });

  it('respects the limit parameter', () => {
    const docs: AnalyticsDoc[] = Array.from({ length: 15 }, (_, i) =>
      doc({ id: String(i), sender: `Sender${i}`, amount: i })
    );
    const result = buildTopVendors(docs, 5);
    expect(result).toHaveLength(5);
  });

  it('excludes documents without a sender', () => {
    const docs: AnalyticsDoc[] = [doc({ id: '1', sender: null, amount: 100 })];
    expect(buildTopVendors(docs)).toEqual([]);
  });
});

describe('detectRecurringSubscriptions', () => {
  it('detects a monthly subscription from 3 documents ~30 days apart with near-identical amounts', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'Netflix', document_date: '2026-01-01', amount: 12.99 }),
      doc({ id: '2', sender: 'Netflix', document_date: '2026-01-31', amount: 12.99 }),
      doc({ id: '3', sender: 'Netflix', document_date: '2026-03-02', amount: 12.99 }),
    ];

    const result = detectRecurringSubscriptions(docs);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sender: 'Netflix', cadence: 'monthly', occurrences: 3 });
    expect(result[0].averageAmount).toBeCloseTo(12.99, 2);
  });

  it('detects a yearly subscription from 2 documents ~365 days apart with similar amounts', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'Domain Registrar Inc', document_date: '2025-06-01', amount: 14.0 }),
      doc({ id: '2', sender: 'Domain Registrar Inc', document_date: '2026-06-02', amount: 14.5 }),
    ];

    const result = detectRecurringSubscriptions(docs);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sender: 'Domain Registrar Inc', cadence: 'yearly', occurrences: 2 });
  });

  it('does not flag two unrelated one-off documents from different senders', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'Random Shop A', document_date: '2026-01-01', amount: 45 }),
      doc({ id: '2', sender: 'Random Shop B', document_date: '2026-06-15', amount: 200 }),
    ];

    expect(detectRecurringSubscriptions(docs)).toEqual([]);
  });

  it('does not flag documents from the same sender with dissimilar amounts even if timing matches', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'Irregular Vendor', document_date: '2026-01-01', amount: 10 }),
      doc({ id: '2', sender: 'Irregular Vendor', document_date: '2026-01-30', amount: 1000 }),
    ];

    expect(detectRecurringSubscriptions(docs)).toEqual([]);
  });

  it('does not flag documents from the same sender with an irregular (non-monthly, non-yearly) interval', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: 'One-off Vendor', document_date: '2026-01-01', amount: 50 }),
      doc({ id: '2', sender: 'One-off Vendor', document_date: '2026-01-10', amount: 50 }),
    ];

    expect(detectRecurringSubscriptions(docs)).toEqual([]);
  });

  it('groups senders case-insensitively and trims whitespace', () => {
    const docs: AnalyticsDoc[] = [
      doc({ id: '1', sender: ' Spotify ', document_date: '2026-01-01', amount: 9.99 }),
      doc({ id: '2', sender: 'spotify', document_date: '2026-01-31', amount: 9.99 }),
    ];

    const result = detectRecurringSubscriptions(docs);
    expect(result).toHaveLength(1);
    expect(result[0].cadence).toBe('monthly');
  });
});
