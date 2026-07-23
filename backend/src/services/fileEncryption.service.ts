import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest();
}

export interface FileEncryptionResult {
  iv: string; // hex
  authTag: string; // hex
}

/**
 * Streams a file through AES-256-GCM encryption, so memory use stays flat
 * regardless of file size. The IV and auth tag are returned to the caller
 * to store in the database alongside the document row (per-file IV,
 * "stored securely" per the ticket) rather than embedded in the encrypted
 * file itself.
 */
export function encryptFile(
  sourcePath: string,
  destPath: string,
  masterKey: string = config.mfaEncryptionKey
): Promise<FileEncryptionResult> {
  return new Promise((resolve, reject) => {
    const key = deriveKey(masterKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    const source = fs.createReadStream(sourcePath);
    const dest = fs.createWriteStream(destPath);

    pipeline(source, cipher, dest)
      .then(() => {
        resolve({ iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') });
      })
      .catch(reject);
  });
}

/** Streams an encrypted file back to plaintext, given its stored IV + auth tag. */
export function decryptFile(
  sourcePath: string,
  destPath: string,
  ivHex: string,
  authTagHex: string,
  masterKey: string = config.mfaEncryptionKey
): Promise<void> {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const source = fs.createReadStream(sourcePath);
  const dest = fs.createWriteStream(destPath);

  return pipeline(source, decipher, dest);
}

/**
 * Returns a Decipher transform stream that can be piped directly from an
 * encrypted file's read stream to an HTTP response, decrypting on-the-fly
 * without ever writing a plaintext copy to disk.
 */
export function createDecryptStream(ivHex: string, authTagHex: string, masterKey: string = config.mfaEncryptionKey) {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher;
}

/** Re-encrypts a file with a new master key, for key rotation. */
export async function reencryptFile(
  sourcePath: string,
  destPath: string,
  oldIv: string,
  oldAuthTag: string,
  oldKey: string,
  newKey: string
): Promise<FileEncryptionResult> {
  const tmpPlainPath = `${destPath}.rotating.tmp`;
  try {
    await decryptFile(sourcePath, tmpPlainPath, oldIv, oldAuthTag, oldKey);
    return await encryptFile(tmpPlainPath, destPath, newKey);
  } finally {
    if (fs.existsSync(tmpPlainPath)) {
      fs.unlinkSync(tmpPlainPath);
    }
  }
}
