import bcrypt from 'bcryptjs';

// Mirrors mfa.service.ts's BCRYPT_ROUNDS convention (10), used consistently
// across auth.routes.ts / mfa.service.ts for password hashing in this codebase.
export const BCRYPT_ROUNDS = 10;

// Lockout thresholds for guest share-link password attempts. Mirrors the
// login rate-limiting convention used in auth.routes.ts's MFA verification
// (5 attempts / 15 minute window) for consistency across the codebase.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface ShareLinkRow {
  id: string;
  document_id: string;
  token: string;
  password_hash: string | null;
  expires_at: string | Date | null;
  max_downloads: number | null;
  download_count: number;
  failed_attempts: number;
  locked_until: string | Date | null;
  created_by: string | null;
  created_at: string | Date;
  revoked_at: string | Date | null;
}

export type ShareLinkInvalidReason = 'expired' | 'revoked' | 'limit_exceeded' | 'locked';

export interface ShareLinkValidity {
  valid: boolean;
  reason?: ShareLinkInvalidReason;
}

/**
 * Pure validity check for a share link row: expiry, revocation, download
 * limit, and password-attempt lockout. Order matters for the reason
 * reported to the (untrusted) guest caller, but every branch independently
 * blocks access regardless of order.
 */
export function isShareLinkValid(link: ShareLinkRow, now: Date = new Date()): ShareLinkValidity {
  if (link.revoked_at) {
    return { valid: false, reason: 'revoked' };
  }

  if (link.expires_at && new Date(link.expires_at) <= now) {
    return { valid: false, reason: 'expired' };
  }

  if (link.max_downloads !== null && link.max_downloads !== undefined && link.download_count >= link.max_downloads) {
    return { valid: false, reason: 'limit_exceeded' };
  }

  if (link.locked_until && new Date(link.locked_until) > now) {
    return { valid: false, reason: 'locked' };
  }

  return { valid: true };
}

/** Thin wrapper around bcrypt.compare for guest share-link password checks. */
export async function verifySharePassword(plaintextPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plaintextPassword, passwordHash);
}

/** Hashes a share-link password with the same salt-round convention used elsewhere in this codebase. */
export async function hashSharePassword(plaintextPassword: string): Promise<string> {
  return bcrypt.hash(plaintextPassword, BCRYPT_ROUNDS);
}

/**
 * Computes the new failed_attempts / locked_until values after a failed
 * password attempt, locking the link out for LOCKOUT_MINUTES once
 * MAX_FAILED_ATTEMPTS is reached.
 */
export function computeLockoutAfterFailedAttempt(
  currentFailedAttempts: number,
  now: Date = new Date()
): { failedAttempts: number; lockedUntil: Date | null } {
  const failedAttempts = currentFailedAttempts + 1;
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000);
    return { failedAttempts, lockedUntil };
  }
  return { failedAttempts, lockedUntil: null };
}
