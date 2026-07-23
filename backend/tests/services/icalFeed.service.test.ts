import { describe, it, expect } from 'vitest';
import { buildIcsFeed, DocumentForFeed } from '../../src/services/icalFeed.service';

const NOW = new Date('2026-07-23T00:00:00Z');

describe('buildIcsFeed', () => {
  it('produces a valid VCALENDAR wrapper with CRLF line endings', () => {
    const ics = buildIcsFeed([], NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain('PRODID:-//DocVault//Calendar Feed//DE\r\n');
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('emits a VEVENT with an all-day DTSTART and invoice-style SUMMARY for a payment due date', () => {
    const documents: DocumentForFeed[] = [
      {
        id: 'doc-1',
        title: 'Invoice.pdf',
        doc_type: 'Rechnung',
        sender: 'Dell Technologies GmbH',
        due_date: '2026-08-15',
        amount: 1499.0,
        currency: 'EUR',
      },
    ];

    const ics = buildIcsFeed(documents, NOW);

    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('DTSTART:20260815');
    expect(ics).toContain('SUMMARY:Zahlung fällig: Dell Technologies GmbH (1499 EUR)');
    expect(ics).toContain('DESCRIPTION:Dokument: Invoice.pdf');
  });

  it('generates 30/60-day reminder events for a contract-type document with a future due_date', () => {
    const documents: DocumentForFeed[] = [
      {
        id: 'doc-2',
        title: 'Mietvertrag.pdf',
        doc_type: 'Vertrag',
        sender: 'Hausverwaltung Meyer',
        due_date: '2026-12-01', // ~131 days from NOW: both 30 and 60 day reminders are future
        amount: null,
        currency: null,
      },
    ];

    const ics = buildIcsFeed(documents, NOW);

    // 1 due-date event + 2 reminder events = 3 VEVENTs
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(3);
    expect(ics).toContain('Kündigungsfrist in 30 Tagen: Hausverwaltung Meyer');
    expect(ics).toContain('Kündigungsfrist in 60 Tagen: Hausverwaltung Meyer');
    // 2026-12-01 minus 30 days = 2026-11-01, minus 60 days = 2026-10-02
    expect(ics).toContain('DTSTART:20261101');
    expect(ics).toContain('DTSTART:20261002');
  });

  it('does NOT emit reminder events for a contract whose due_date is already in the past', () => {
    const documents: DocumentForFeed[] = [
      {
        id: 'doc-3',
        title: 'AlterVertrag.pdf',
        doc_type: 'Vertrag',
        sender: 'Alt AG',
        due_date: '2020-01-01',
        amount: null,
        currency: null,
      },
    ];

    const ics = buildIcsFeed(documents, NOW);

    // Only the main due-date event, no reminders (both 30/60-day dates are also past).
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(ics).not.toContain('Kündigungsfrist');
    // The due-date event itself is still included even though it's in the past.
    expect(ics).toContain('DTSTART:20200101');
  });

  it('does not emit reminder events for non-contract document types (e.g. invoices)', () => {
    const documents: DocumentForFeed[] = [
      {
        id: 'doc-4',
        title: 'Rechnung.pdf',
        doc_type: 'Rechnung',
        sender: 'Stromanbieter',
        due_date: '2026-12-01',
        amount: 50,
        currency: 'EUR',
      },
    ];

    const ics = buildIcsFeed(documents, NOW);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(ics).not.toContain('Kündigungsfrist');
  });

  it('skips documents with no due_date', () => {
    const documents: DocumentForFeed[] = [
      {
        id: 'doc-5',
        title: 'NoDueDate.pdf',
        doc_type: 'Sonstiges',
        sender: 'X',
        due_date: null,
        amount: null,
        currency: null,
      },
    ];

    const ics = buildIcsFeed(documents, NOW);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
