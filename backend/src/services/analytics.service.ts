/**
 * Pure, DB-free analytics functions (Ticket #14 — Expense Analytics & Recurring
 * Cost Dashboard). All functions here operate purely on already-fetched rows so
 * they can be unit tested without a database connection.
 */

export interface AnalyticsDoc {
  id: string;
  sender: string | null;
  document_date: string | Date | null;
  amount: number | string | null;
  currency: string | null;
}

export interface MonthlyBreakdownEntry {
  month: string; // YYYY-MM
  total: number;
  count: number;
}

export interface VendorEntry {
  sender: string;
  total: number;
  count: number;
}

export interface RecurringSubscription {
  sender: string;
  cadence: 'monthly' | 'yearly';
  averageAmount: number;
  occurrences: number;
}

function toAmount(amount: number | string | null): number {
  if (amount === null || amount === undefined) return 0;
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Number.isFinite(n) ? n : 0;
}

function toDate(d: string | Date | null): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Groups documents by `YYYY-MM` (derived from `document_date`), summing
 * `amount` per month. Documents with no parseable `document_date` are
 * excluded. Returns entries sorted ascending by month.
 */
export function buildMonthlyBreakdown(documents: AnalyticsDoc[]): MonthlyBreakdownEntry[] {
  const byMonth = new Map<string, { total: number; count: number }>();

  for (const doc of documents) {
    const date = toDate(doc.document_date);
    if (!date) continue;
    const key = monthKey(date);
    const existing = byMonth.get(key) || { total: 0, count: 0 };
    existing.total += toAmount(doc.amount);
    existing.count += 1;
    byMonth.set(key, existing);
  }

  return Array.from(byMonth.entries())
    .map(([month, { total, count }]) => ({ month, total: Math.round(total * 100) / 100, count }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/**
 * Groups documents by `sender`, summing `amount` and counting documents.
 * Returns the top `limit` senders sorted descending by total spend.
 * Documents with no sender are excluded.
 */
export function buildTopVendors(documents: AnalyticsDoc[], limit = 10): VendorEntry[] {
  const bySender = new Map<string, { total: number; count: number }>();

  for (const doc of documents) {
    const sender = doc.sender?.trim();
    if (!sender) continue;
    const existing = bySender.get(sender) || { total: 0, count: 0 };
    existing.total += toAmount(doc.amount);
    existing.count += 1;
    bySender.set(sender, existing);
  }

  return Array.from(bySender.entries())
    .map(([sender, { total, count }]) => ({ sender, total: Math.round(total * 100) / 100, count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTHLY_INTERVAL_MIN_DAYS = 28;
const MONTHLY_INTERVAL_MAX_DAYS = 32;
const YEARLY_INTERVAL_MIN_DAYS = 350;
const YEARLY_INTERVAL_MAX_DAYS = 380;
const AMOUNT_TOLERANCE = 0.05; // 5%

function amountsSimilar(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) return true;
  return Math.abs(a - b) / larger <= AMOUNT_TOLERANCE;
}

/**
 * Heuristic recurring-subscription detector.
 *
 * Rule-based approach (not ML): for each sender (grouped case-insensitively,
 * trimmed), sort their documents chronologically by `document_date`, then
 * look at consecutive gaps between documents. If a gap falls within the
 * "monthly" window (28-32 days) OR the "yearly" window (350-380 days) AND
 * the two documents' amounts are within 5% of each other, we count that as
 * one recurring "link". A sender needs at least one such link (i.e. at
 * least 2 occurrences that satisfy the interval+amount heuristic) to be
 * reported as a recurring subscription. If a sender has links matching both
 * cadences, monthly is preferred (more common invoicing cycle) since a
 * short run of monthly documents can incidentally also contain a ~360-day
 * gap between the first and last if there are enough of them — but we only
 * ever compare consecutive documents so this is a rare edge case.
 *
 * The `averageAmount` is the mean amount across the qualifying occurrences
 * (i.e. all documents that participated in at least one qualifying gap),
 * and `occurrences` is the count of those documents.
 */
export function detectRecurringSubscriptions(documents: AnalyticsDoc[]): RecurringSubscription[] {
  const bySender = new Map<string, AnalyticsDoc[]>();

  for (const doc of documents) {
    const sender = doc.sender?.trim();
    if (!sender) continue;
    const date = toDate(doc.document_date);
    if (!date) continue;
    const key = sender.toLowerCase();
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key)!.push(doc);
  }

  const results: RecurringSubscription[] = [];

  for (const [, docs] of bySender) {
    if (docs.length < 2) continue;

    const sorted = docs
      .map((d) => ({ doc: d, date: toDate(d.document_date)!, amount: toAmount(d.amount) }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const monthlyIndices = new Set<number>();
    const yearlyIndices = new Set<number>();

    for (let i = 0; i < sorted.length - 1; i++) {
      const gapDays = (sorted[i + 1].date.getTime() - sorted[i].date.getTime()) / MS_PER_DAY;
      const similarAmounts = amountsSimilar(sorted[i].amount, sorted[i + 1].amount);

      if (!similarAmounts) continue;

      if (gapDays >= MONTHLY_INTERVAL_MIN_DAYS && gapDays <= MONTHLY_INTERVAL_MAX_DAYS) {
        monthlyIndices.add(i);
        monthlyIndices.add(i + 1);
      } else if (gapDays >= YEARLY_INTERVAL_MIN_DAYS && gapDays <= YEARLY_INTERVAL_MAX_DAYS) {
        yearlyIndices.add(i);
        yearlyIndices.add(i + 1);
      }
    }

    // Prefer monthly cadence if there's any monthly evidence; otherwise
    // fall back to yearly evidence.
    const cadence: 'monthly' | 'yearly' | null =
      monthlyIndices.size >= 2 ? 'monthly' : yearlyIndices.size >= 2 ? 'yearly' : null;
    if (!cadence) continue;

    const indices = cadence === 'monthly' ? monthlyIndices : yearlyIndices;
    const qualifyingAmounts = Array.from(indices).map((i) => sorted[i].amount);
    const averageAmount =
      Math.round((qualifyingAmounts.reduce((sum, a) => sum + a, 0) / qualifyingAmounts.length) * 100) / 100;

    results.push({
      sender: sorted[0].doc.sender!.trim(),
      cadence,
      averageAmount,
      occurrences: indices.size,
    });
  }

  return results.sort((a, b) => b.occurrences - a.occurrences);
}
