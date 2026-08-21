import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

export class StorageService {
  public static initStorageDirectories() {
    const dirs = ['originals', 'derived', 'thumbnails', 'input'];
    dirs.forEach((dir) => {
      const fullPath = path.join(config.storagePath, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    });
    const replicaOriginals = path.join(config.storageReplicaPath, 'originals');
    if (!fs.existsSync(replicaOriginals)) {
      fs.mkdirSync(replicaOriginals, { recursive: true });
    }
  }

  public static calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(err));
    });
  }

  public static getOriginalFilePath(filename: string): string {
    const targetDir = StorageService.originalsDir(config.storagePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return path.join(targetDir, filename);
  }

  /**
   * Computes the replica's path without creating the directory: the
   * replica write only happens after the primary is already durable, and
   * doing it here (before the caller even knows the primary succeeded)
   * would perform a storage side effect too early. writeVerifiedCopy and
   * linkExistingCopy create the directory themselves when they actually write.
   */
  public static getReplicaFilePath(filename: string): string {
    return path.join(StorageService.originalsDir(config.storageReplicaPath), filename);
  }

  private static originalsDir(root: string): string {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return path.join(root, 'originals', year, month);
  }

  /**
   * Copies sourcePath to destPath and hashes the written bytes back off
   * disk before accepting the copy -- catches truncated writes and silent
   * corruption on the destination volume, not just failed syscalls.
   * Cleans up destPath on mismatch so a retry starts from a clean slate.
   */
  public static async writeVerifiedCopy(
    sourcePath: string,
    destPath: string,
    expectedHash: string
  ): Promise<void> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.copyFile(sourcePath, destPath);
    const actualHash = await StorageService.calculateFileHash(destPath);
    if (actualHash !== expectedHash) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw new Error(`Durability copy hash mismatch for ${destPath}`);
    }
  }

  /**
   * Hardlinks an already-durable file into a new path instead of writing
   * fresh bytes -- used to dedupe exact-duplicate content onto the same
   * disk blocks. Safe to delete either the source or destination document
   * later: the filesystem keeps the data until the last link is removed.
   */
  public static async linkExistingCopy(existingPath: string, destPath: string): Promise<void> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.link(existingPath, destPath);
  }
}
