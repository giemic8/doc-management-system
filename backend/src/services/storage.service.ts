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
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const targetDir = path.join(config.storagePath, 'originals', year, month);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return path.join(targetDir, filename);
  }
}
