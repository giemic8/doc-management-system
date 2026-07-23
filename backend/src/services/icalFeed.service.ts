/**
 * Ticket #13 — iCal / ICS Dynamic Calendar Subscription Feed.
 *
 * Builds an RFC 5545 iCalendar (.ics) document from a list of documents
 * that have payment due dates and/or contract notice-period deadlines.
 *
 * Schema note: the `documents` table has no dedicated "contract notice
 * period deadline" column. Per the ticket, we reuse `due_date` semantically
 * for both purposes: for invoice-like documents it's the payment due date,
 * and for contract-like documents (`doc_type` matching one of
 * CONTRACT_DOC_TYPES) it's treated as the notice/cancellation deadline.
 *
 * This module is intentionally pure (no DB access, no Express req/res) so
 * it can be unit tested directly — all data must be passed in already
 * loaded from the database by the route handler.
 */

export interface DocumentForFeed {
  id: string;
  title: string;
  doc_type: string | null;
  sender: string | null;
  due_date: string | Date | null;
  amount: number | string | null;
  currency: string | null;
}

// Doc types treated as "contract-like" for the purposes of notice-period
// reminders. Case-insensitive match against `doc_type`.
const CONTRACT_DOC_TYPES = ['vertrag', 'contract'];

const REMINDER_DAYS_BEFORE = [30, 60];

function isContractType(docType: string | null): boolean {
  if (!docType) return false;
  return CONTRACT_DOC_TYPES.includes(docType.toLowerCase());
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Formats a Date as YYYYMMDD (all-day event date, per RFC 5545). */
function formatAllDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Formats a Date as a UTC timestamp, e.g. 20260723T000000Z. */
function formatUtcTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

interface VEvent {
  uid: string;
  dtstamp: string;
  dtstart: string;
  summary: string;
  description: string;
}

function buildEvent(event: VEvent): string {
  return [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${event.dtstamp}`,
    `DTSTART:${event.dtstart}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    'END:VEVENT',
  ].join('\r\n');
}

/**
 * Builds the full ICS feed body for a set of documents. Pure function —
 * no DB/network access — so it's directly unit-testable.
 */
export function buildIcsFeed(documents: DocumentForFeed[], now: Date = new Date()): string {
  const dtstamp = formatUtcTimestamp(now);
  const events: string[] = [];

  for (const doc of documents) {
    if (!doc.due_date) continue;

    const dueDate = toDate(doc.due_date);
    const amountLabel = doc.amount != null ? `${doc.amount} ${doc.currency || 'EUR'}` : '';
    const sender = doc.sender || 'Unbekannt';
    const documentLink = `Dokument: ${doc.title} (/api/documents/${doc.id})`;

    // Main due-date event. Emitted regardless of whether it's in the past
    // relative to `now` — calendar clients render past all-day events
    // fine, and users may want the history preserved in their calendar.
    events.push(
      buildEvent({
        uid: `doc-${doc.id}-due@docvault`,
        dtstamp,
        dtstart: formatAllDay(dueDate),
        summary: amountLabel
          ? `Zahlung fällig: ${sender} (${amountLabel})`
          : `Fällig: ${sender}`,
        description: documentLink,
      })
    );

    // Contract notice-period reminders, 30/60 days prior. Only emitted if
    // the resulting reminder date is still in the future relative to
    // `now`, so the feed isn't cluttered with reminders for deadlines
    // that have already passed.
    if (isContractType(doc.doc_type)) {
      for (const daysBefore of REMINDER_DAYS_BEFORE) {
        const reminderDate = addDays(dueDate, -daysBefore);
        if (reminderDate.getTime() <= now.getTime()) continue;

        events.push(
          buildEvent({
            uid: `doc-${doc.id}-reminder-${daysBefore}@docvault`,
            dtstamp,
            dtstart: formatAllDay(reminderDate),
            summary: `Kündigungsfrist in ${daysBefore} Tagen: ${sender}`,
            description: documentLink,
          })
        );
      }
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DocVault//Calendar Feed//DE',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}
