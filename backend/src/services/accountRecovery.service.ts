import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool, query } from '../database/db';

/**
 * Ticket #34 -- account recovery that does not become a way into somebody
 * else's private space.
 *
 * The obvious way to let a family member back into a locked account is to
 * let the admin reset their password. That is precisely what a private
 * space has to rule out: an admin who can become you can read everything
 * you kept private, and nothing in the audit trail distinguishes that from
 * you logging in yourself. So this system has no admin password reset at
 * all. Instead:
 *
 * - recovery codes are generated **by the account owner, for their own
 *   account**, and shown exactly once. Only bcrypt hashes are stored, so
 *   nobody with database access -- admin included -- can recover a code;
 * - redeeming one proves possession of something only the owner ever held,
 *   and sets a new password;
 * - each code works once, and generating a new set invalidates the old one;
 * - redemption is audited, so an owner can see that it happened;
 * - MFA is deliberately NOT cleared by a redemption. A recovery code
 *   restores the password factor only; a lost second factor is what the
 *   separate MFA backup codes are for. So a stolen recovery code still does
 *   not open an MFA-protected account.
 *
 * The remaining way into someone else's private space is the emergency
 * flow: two people, time-bounded, read-only, audited.
 */

export const RECOVERY_CODE_COUNT = 8;

export type RecoveryErrorReason = 'invalid_input' | 'invalid_code' | 'weak_password';

export class RecoveryError extends Error {
  public readonly status: number;
  public readonly reason: RecoveryErrorReason;

  constructor(status: number, reason: RecoveryErrorReason, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.status = status;
    this.reason = reason;
  }
}

/** `A1B2-C3D4-E5F6` -- grouped so it can be read off paper without mistakes. */
function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Replaces the user's recovery codes and returns the new plaintext set.
 * The caller must show them once and then forget them; they are not
 * retrievable afterwards.
 */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((code) => bcrypt.hash(code, 10)));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A new set replaces the old one outright, including codes already used:
    // leaving spent rows behind would only make "how many are left" lie.
    await client.query(`DELETE FROM user_recovery_codes WHERE user_id = $1;`, [userId]);
    for (const hash of hashes) {
      await client.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2);`, [userId, hash]);
    }
    await client.query(
      `INSERT INTO audit_logs (user_id, action, details) VALUES ($1, 'recovery_codes_generated', $2);`,
      [userId, JSON.stringify({ count: codes.length })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return codes;
}

export async function countLiveRecoveryCodes(userId: string): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL;`,
    [userId]
  );
  return result.rows[0].count;
}

export interface RedeemRecoveryInput {
  email: string;
  code: string;
  newPassword: string;
  ip?: string;
}

/**
 * Sets a new password on proof of one unused recovery code. Returns the
 * user id on success.
 *
 * An unknown email and a wrong code produce the same failure on purpose:
 * this endpoint is unauthenticated, and telling a stranger which family
 * addresses exist is a free gift.
 */
export async function redeemRecoveryCode(input: RedeemRecoveryInput): Promise<string> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const code = typeof input.code === 'string' ? normalizeCode(input.code) : '';
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';

  if (!email || !code) {
    throw new RecoveryError(400, 'invalid_input', 'email and code are required');
  }
  if (newPassword.length < 8) {
    throw new RecoveryError(400, 'weak_password', 'newPassword must be at least 8 characters');
  }

  const userRes = await query(`SELECT id FROM users WHERE lower(email) = $1;`, [email]);
  const user = userRes.rows[0];
  if (!user) {
    throw new RecoveryError(401, 'invalid_code', 'That recovery code is not valid');
  }

  const codesRes = await query(
    `SELECT id, code_hash FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL;`,
    [user.id]
  );

  let matchedId: string | null = null;
  for (const row of codesRes.rows) {
    if (await bcrypt.compare(code, row.code_hash)) {
      matchedId = row.id;
      break;
    }
  }

  if (!matchedId) {
    await query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, 'account_recovery_failed', $2, $3);`,
      [user.id, JSON.stringify({ email }), input.ip ?? null]
    );
    throw new RecoveryError(401, 'invalid_code', 'That recovery code is not valid');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Marking the code spent inside the same transaction as the password
    // change is what makes "each code works once" true under concurrency.
    const spent = await client.query(
      `UPDATE user_recovery_codes SET used_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND used_at IS NULL RETURNING id;`,
      [matchedId]
    );
    if (spent.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new RecoveryError(401, 'invalid_code', 'That recovery code is not valid');
    }

    await client.query(`UPDATE users SET password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`, [
      user.id,
      passwordHash,
    ]);
    await client.query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, 'account_recovery_used', $2, $3);`,
      [user.id, JSON.stringify({ recoveryCodeId: matchedId }), input.ip ?? null]
    );
    await client.query('COMMIT');
  } catch (err) {
    if (!(err instanceof RecoveryError)) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }

  return user.id;
}
