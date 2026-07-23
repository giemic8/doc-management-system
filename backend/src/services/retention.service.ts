export function calculateRetentionExpiry(startDate: Date, years: number): Date {
  const expiry = new Date(startDate);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + years);
  return expiry;
}

export interface RetentionState {
  retention_until: Date | string | null;
  legal_hold: boolean;
}

/**
 * A document is locked against deletion/modification if either a legal
 * hold is active, or its retention period hasn't expired yet.
 */
export function isRetentionLocked(doc: RetentionState): boolean {
  if (doc.legal_hold) return true;
  if (!doc.retention_until) return false;
  return new Date(doc.retention_until).getTime() > Date.now();
}
