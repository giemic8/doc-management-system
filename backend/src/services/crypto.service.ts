import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function deriveKey(): Buffer {
  // Normalize the configured key to a 32-byte key via SHA-256, so any
  // MFA_ENCRYPTION_KEY string (of any length) is usable with AES-256.
  return crypto.createHash('sha256').update(config.mfaEncryptionKey).digest();
}

/**
 * Encrypts a plaintext secret (e.g. a base32 TOTP secret) for storage at
 * rest. Returns a single string: `iv:authTag:ciphertext`, all hex-encoded.
 */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a secret produced by encryptSecret. Throws if the ciphertext
 * has been tampered with (GCM auth tag mismatch) or is malformed.
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret payload');
  }
  const [ivHex, authTagHex, encryptedHex] = parts;

  const key = deriveKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
