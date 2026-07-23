/**
 * Pure(ish) helpers for the backup health/status feature (Ticket #17 —
 * Offsite Backup & Automated Disaster Recovery).
 *
 * The `backup` container writes /backups/last-backup-status.json after each
 * daily run (see backup/scripts/run-backup.sh). This service reads and
 * parses that file for the backend's GET /api/backup/status route. Kept as
 * a standalone function (rather than inline in the route) so it's testable
 * without spinning up a real filesystem fixture for every case.
 */
import fs from 'fs';
import path from 'path';

export interface BackupStatus {
  timestamp: string | null;
  dbBackupSizeBytes: number;
  storageBackupSizeBytes: number;
  success: boolean;
  error?: string;
}

/**
 * Reads and parses the backup status JSON file at `filePath`.
 * Returns a graceful "no backup yet" shape if the file doesn't exist, and a
 * graceful error shape if it exists but can't be parsed — never throws.
 */
export function parseBackupStatusFile(filePath: string): BackupStatus {
  if (!fs.existsSync(filePath)) {
    return {
      timestamp: null,
      dbBackupSizeBytes: 0,
      storageBackupSizeBytes: 0,
      success: false,
      error: 'No backup has run yet',
    };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      timestamp: parsed.timestamp ?? null,
      dbBackupSizeBytes: Number(parsed.dbBackupSizeBytes) || 0,
      storageBackupSizeBytes: Number(parsed.storageBackupSizeBytes) || 0,
      success: Boolean(parsed.success),
      ...(parsed.error ? { error: String(parsed.error) } : {}),
    };
  } catch (err: any) {
    return {
      timestamp: null,
      dbBackupSizeBytes: 0,
      storageBackupSizeBytes: 0,
      success: false,
      error: `Failed to parse backup status file: ${err.message}`,
    };
  }
}

/**
 * Recursively sums file sizes under `dirPath` to approximate current
 * storage usage for the admin dashboard. Simple approach: no caching, walks
 * the whole tree on each request. Fine for the document-storage directory
 * sizes expected here; if this ever becomes a bottleneck on very large
 * storage volumes, swap for `du -sb` (shelling out) or a periodically
 * refreshed cache.
 */
export function computeStorageUsageBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;

  let total = 0;
  const stack: string[] = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {
          // Skip files that vanish mid-walk or are unreadable.
        }
      }
    }
  }

  return total;
}
