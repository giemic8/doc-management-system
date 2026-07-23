import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { encryptFile, decryptFile } from '../../src/services/fileEncryption.service';

function tmpFile(content: Buffer): string {
  const p = path.join(os.tmpdir(), `test-${crypto.randomUUID()}.bin`);
  fs.writeFileSync(p, content);
  return p;
}

describe('fileEncryption.service', () => {
  it('round-trips a small file through encrypt/decrypt', async () => {
    const original = Buffer.from('Hello, this is a test document.');
    const sourcePath = tmpFile(original);
    const encryptedPath = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);
    const decryptedPath = path.join(os.tmpdir(), `dec-${crypto.randomUUID()}.bin`);

    const { iv, authTag } = await encryptFile(sourcePath, encryptedPath);
    await decryptFile(encryptedPath, decryptedPath, iv, authTag);

    const decrypted = fs.readFileSync(decryptedPath);
    expect(decrypted.equals(original)).toBe(true);
  });

  it('round-trips a larger (multi-chunk) file', async () => {
    const original = crypto.randomBytes(5 * 1024 * 1024); // 5MB, forces multiple stream chunks
    const sourcePath = tmpFile(original);
    const encryptedPath = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);
    const decryptedPath = path.join(os.tmpdir(), `dec-${crypto.randomUUID()}.bin`);

    const { iv, authTag } = await encryptFile(sourcePath, encryptedPath);
    await decryptFile(encryptedPath, decryptedPath, iv, authTag);

    const decrypted = fs.readFileSync(decryptedPath);
    expect(decrypted.equals(original)).toBe(true);
  });

  it('produces ciphertext that differs from the plaintext', async () => {
    const original = Buffer.from('Sensitive contract text');
    const sourcePath = tmpFile(original);
    const encryptedPath = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);

    await encryptFile(sourcePath, encryptedPath);
    const encryptedBytes = fs.readFileSync(encryptedPath);

    expect(encryptedBytes.equals(original)).toBe(false);
  });

  it('uses a different IV on each call (never reuses an IV for the same key)', async () => {
    const sourcePath = tmpFile(Buffer.from('same content'));
    const encA = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);
    const encB = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);

    const resultA = await encryptFile(sourcePath, encA);
    const resultB = await encryptFile(sourcePath, encB);

    expect(resultA.iv).not.toBe(resultB.iv);
  });

  it('fails to decrypt with a tampered auth tag', async () => {
    const sourcePath = tmpFile(Buffer.from('tamper test'));
    const encryptedPath = path.join(os.tmpdir(), `enc-${crypto.randomUUID()}.bin`);
    const decryptedPath = path.join(os.tmpdir(), `dec-${crypto.randomUUID()}.bin`);

    const { iv, authTag } = await encryptFile(sourcePath, encryptedPath);
    const tamperedAuthTag = authTag.slice(0, -2) + (authTag.slice(-2) === 'aa' ? 'bb' : 'aa');

    await expect(decryptFile(encryptedPath, decryptedPath, iv, tamperedAuthTag)).rejects.toThrow();
  });
});
