import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';

const APP_NAME = 'DocVault';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;
const BCRYPT_ROUNDS = 10;

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function buildTotpUri(secret: string, accountEmail: string): string {
  return authenticator.keyuri(accountEmail, APP_NAME, secret);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}

/** Generates N unique random numeric backup codes, e.g. "48213076". */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const code = crypto.randomInt(0, 10 ** BACKUP_CODE_LENGTH).toString().padStart(BACKUP_CODE_LENGTH, '0');
    codes.add(code);
  }
  return Array.from(codes);
}

export async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

export async function verifyBackupCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
