import { Router, Response } from 'express';
import { AuthRequest, authenticateToken, requireRole } from '../middleware/auth';
import { config } from '../config';
import { parseBackupStatusFile, computeStorageUsageBytes } from '../services/backupStatus.service';

const router = Router();

// GET /api/backup/status
// Admin-only dashboard data: last backup health + current storage usage.
router.get('/status', authenticateToken, requireRole(['admin']), async (_req: AuthRequest, res: Response) => {
  try {
    const status = parseBackupStatusFile(config.backupStatusPath);
    const storageUsageBytes = computeStorageUsageBytes(config.storagePath);

    return res.json({ ...status, storageUsageBytes });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
