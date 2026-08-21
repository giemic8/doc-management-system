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
  version: number;
  backupId: string | null;
  timestamp: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastRestoreAt: string | null;
  dbBackupSizeBytes: number;
  storageBackupSizeBytes: number;
  success: boolean;
  stages: Record<BackupStageName, BackupStage>;
  restore: RestoreVerification;
  dashboardAlert: { active: boolean; message: string | null };
  emailAlert: { attempted: boolean; sent: boolean; detail: string | null };
  error?: string;
}

export type BackupStageName = 'created' | 'replicated' | 'uploaded' | 'retained' | 'decrypted' | 'restored';
export type BackupStageState = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface BackupStage {
  state: BackupStageState;
  at: string | null;
  detail?: string;
}

export interface RestoreVerification {
  backupId: string | null;
  databaseVerified: boolean;
  sampledOriginalsChecked: number;
  sampledOriginalsMatched: number;
}

const stageNames: BackupStageName[] = ['created', 'replicated', 'uploaded', 'retained', 'decrypted', 'restored'];

function emptyStages(): Record<BackupStageName, BackupStage> {
  return Object.fromEntries(stageNames.map((name) => [name, { state: 'pending', at: null }])) as Record<
    BackupStageName,
    BackupStage
  >;
}

function emptyStatus(error: string): BackupStatus {
  return {
    version: 2,
    backupId: null,
    timestamp: null,
    startedAt: null,
    completedAt: null,
    lastRestoreAt: null,
    dbBackupSizeBytes: 0,
    storageBackupSizeBytes: 0,
    success: false,
    stages: emptyStages(),
    restore: { backupId: null, databaseVerified: false, sampledOriginalsChecked: 0, sampledOriginalsMatched: 0 },
    dashboardAlert: { active: true, message: error },
    emailAlert: { attempted: false, sent: false, detail: null },
    error,
  };
}

function normalizeStage(value: unknown): BackupStage {
  if (!value || typeof value !== 'object') return { state: 'pending', at: null };
  const candidate = value as Record<string, unknown>;
  const validStates: BackupStageState[] = ['pending', 'succeeded', 'failed', 'skipped'];
  const state = validStates.includes(candidate.state as BackupStageState)
    ? (candidate.state as BackupStageState)
    : 'pending';
  return {
    state,
    at: typeof candidate.at === 'string' ? candidate.at : null,
    ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
  };
}

/**
 * Reads and parses the backup status JSON file at `filePath`.
 * Returns a graceful "no backup yet" shape if the file doesn't exist, and a
 * graceful error shape if it exists but can't be parsed — never throws.
 */
export function parseBackupStatusFile(filePath: string): BackupStatus {
  if (!fs.existsSync(filePath)) {
    return emptyStatus('No backup has run yet');
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, any>;
    const stages = emptyStages();
    for (const name of stageNames) stages[name] = normalizeStage(parsed.stages?.[name]);
    const error = parsed.error ? String(parsed.error) : undefined;
    return {
      version: Number(parsed.version) || 1,
      backupId: typeof parsed.backupId === 'string' ? parsed.backupId : null,
      timestamp: parsed.timestamp ?? null,
      startedAt: parsed.startedAt ?? parsed.timestamp ?? null,
      completedAt: parsed.completedAt ?? parsed.timestamp ?? null,
      lastRestoreAt: typeof parsed.lastRestoreAt === 'string' ? parsed.lastRestoreAt : null,
      dbBackupSizeBytes: Number(parsed.dbBackupSizeBytes) || 0,
      storageBackupSizeBytes: Number(parsed.storageBackupSizeBytes) || 0,
      success: Boolean(parsed.success),
      stages,
      restore: {
        backupId: typeof parsed.restore?.backupId === 'string' ? parsed.restore.backupId : null,
        databaseVerified: Boolean(parsed.restore?.databaseVerified),
        sampledOriginalsChecked: Number(parsed.restore?.sampledOriginalsChecked) || 0,
        sampledOriginalsMatched: Number(parsed.restore?.sampledOriginalsMatched) || 0,
      },
      dashboardAlert: {
        active: Boolean(parsed.dashboardAlert?.active ?? !parsed.success),
        message:
          typeof parsed.dashboardAlert?.message === 'string'
            ? parsed.dashboardAlert.message
            : error ?? null,
      },
      emailAlert: {
        attempted: Boolean(parsed.emailAlert?.attempted),
        sent: Boolean(parsed.emailAlert?.sent),
        detail: typeof parsed.emailAlert?.detail === 'string' ? parsed.emailAlert.detail : null,
      },
      ...(error ? { error } : {}),
    };
  } catch (err: any) {
    return emptyStatus(`Failed to parse backup status file: ${err.message}`);
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
