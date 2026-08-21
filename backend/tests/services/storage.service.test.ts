import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { StorageService } from '../../src/services/storage.service';

function tmpFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `storage-service-${crypto.randomUUID()}.bin`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('StorageService dual-copy durability primitives', () => {
  it('writes a verified copy when the destination hash matches', async () => {
    const source = tmpFile('durable bytes');
    const dest = path.join(os.tmpdir(), `dest-${crypto.randomUUID()}.bin`);
    const expectedHash = await StorageService.calculateFileHash(source);

    await StorageService.writeVerifiedCopy(source, dest, expectedHash);

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('durable bytes');
  });

  it('rejects and removes the destination when the written copy does not match the expected hash', async () => {
    const source = tmpFile('durable bytes');
    const dest = path.join(os.tmpdir(), `dest-${crypto.randomUUID()}.bin`);
    const wrongHash = crypto.createHash('sha256').update('something else entirely').digest('hex');

    await expect(StorageService.writeVerifiedCopy(source, dest, wrongHash)).rejects.toThrow(
      'Durability copy hash mismatch'
    );
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('creates the destination directory for a verified copy on demand', async () => {
    const source = tmpFile('nested dir bytes');
    const dest = path.join(os.tmpdir(), `nested-${crypto.randomUUID()}`, 'a', 'b', 'dest.bin');
    const expectedHash = await StorageService.calculateFileHash(source);

    await StorageService.writeVerifiedCopy(source, dest, expectedHash);

    expect(fs.existsSync(dest)).toBe(true);
  });

  it('hardlinks an existing durable copy instead of duplicating bytes', async () => {
    const existing = tmpFile('shared content');
    const dest = path.join(os.tmpdir(), `linked-${crypto.randomUUID()}.bin`);

    await StorageService.linkExistingCopy(existing, dest);

    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).ino).toBe(fs.statSync(existing).ino);
    expect(fs.statSync(dest).nlink).toBeGreaterThanOrEqual(2);
  });
});
