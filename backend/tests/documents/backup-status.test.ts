import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';
import { parseBackupStatusFile } from '../../src/services/backupStatus.service';

describe('Backup status (Ticket #17)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('parseBackupStatusFile (pure helper)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-backup-status-'));
    });

    it('parses a valid status file', () => {
      const filePath = path.join(tmpDir, 'last-backup-status.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          timestamp: '2026-07-23T02:00:00Z',
          dbBackupSizeBytes: 1024,
          storageBackupSizeBytes: 2048,
          success: true,
        })
      );

      const result = parseBackupStatusFile(filePath);

      expect(result).toEqual({
        version: 1,
        backupId: null,
        timestamp: '2026-07-23T02:00:00Z',
        startedAt: '2026-07-23T02:00:00Z',
        completedAt: '2026-07-23T02:00:00Z',
        lastRestoreAt: null,
        dbBackupSizeBytes: 1024,
        storageBackupSizeBytes: 2048,
        success: true,
        stages: {
          created: { state: 'pending', at: null },
          replicated: { state: 'pending', at: null },
          uploaded: { state: 'pending', at: null },
          retained: { state: 'pending', at: null },
          decrypted: { state: 'pending', at: null },
          restored: { state: 'pending', at: null },
        },
        restore: {
          backupId: null,
          databaseVerified: false,
          sampledOriginalsChecked: 0,
          sampledOriginalsMatched: 0,
        },
        dashboardAlert: { active: false, message: null },
        emailAlert: { attempted: false, sent: false, detail: null },
      });
    });

    it('includes the error field when present', () => {
      const filePath = path.join(tmpDir, 'last-backup-status.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          timestamp: '2026-07-23T02:00:00Z',
          dbBackupSizeBytes: 0,
          storageBackupSizeBytes: 0,
          success: false,
          error: 'pg_dump exited with code 1',
        })
      );

      const result = parseBackupStatusFile(filePath);

      expect(result.success).toBe(false);
      expect(result.error).toBe('pg_dump exited with code 1');
      expect(result.dashboardAlert).toEqual({ active: true, message: 'pg_dump exited with code 1' });
    });

    it('reports every backup and restore stage from a v2 status file', () => {
      const filePath = path.join(tmpDir, 'last-backup-status.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 2,
          backupId: '20260821-120000',
          timestamp: '2026-08-21T12:05:00Z',
          startedAt: '2026-08-21T12:00:00Z',
          completedAt: '2026-08-21T12:05:00Z',
          success: true,
          stages: {
            created: { state: 'succeeded', at: '2026-08-21T12:01:00Z' },
            replicated: { state: 'succeeded', at: '2026-08-21T12:02:00Z' },
            uploaded: { state: 'succeeded', at: '2026-08-21T12:03:00Z' },
            retained: { state: 'succeeded', at: '2026-08-21T12:03:30Z' },
            decrypted: { state: 'succeeded', at: '2026-08-21T12:04:00Z' },
            restored: { state: 'succeeded', at: '2026-08-21T12:05:00Z' },
          },
          restore: {
            backupId: '20260821-120000',
            databaseVerified: true,
            sampledOriginalsChecked: 12,
            sampledOriginalsMatched: 12,
          },
          dashboardAlert: { active: false, message: null },
          emailAlert: { attempted: false, sent: false, detail: null },
        })
      );

      const result = parseBackupStatusFile(filePath);

      expect(result.backupId).toBe('20260821-120000');
      expect(result.stages.created.state).toBe('succeeded');
      expect(result.stages.uploaded.state).toBe('succeeded');
      expect(result.stages.decrypted.state).toBe('succeeded');
      expect(result.stages.restored.state).toBe('succeeded');
      expect(result.restore).toEqual({
        backupId: '20260821-120000',
        databaseVerified: true,
        sampledOriginalsChecked: 12,
        sampledOriginalsMatched: 12,
      });
    });

    it('returns a graceful "no backup yet" shape when the file is missing', () => {
      const filePath = path.join(tmpDir, 'does-not-exist.json');

      const result = parseBackupStatusFile(filePath);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No backup has run yet');
      expect(result.timestamp).toBeNull();
      expect(result.dbBackupSizeBytes).toBe(0);
      expect(result.storageBackupSizeBytes).toBe(0);
    });

    it('returns a graceful error shape for malformed JSON instead of throwing', () => {
      const filePath = path.join(tmpDir, 'corrupt.json');
      fs.writeFileSync(filePath, '{ this is not valid json');

      const result = parseBackupStatusFile(filePath);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to parse backup status file/);
    });
  });

  describe('GET /api/backup/status', () => {
    it('returns 401 for an unauthenticated request', async () => {
      const res = await request(app).get('/api/backup/status');
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-admin user', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: editor.email, password: editor.password });

      const res = await request(app)
        .get('/api/backup/status')
        .set('Authorization', `Bearer ${loginRes.body.token}`);

      expect(res.status).toBe(403);
    });

    it('returns 200 with a graceful shape for an admin when no backup has run yet', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app).get('/api/backup/status').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body).toHaveProperty('storageUsageBytes');
      expect(res.body).toHaveProperty('stages.created.state');
      expect(res.body).toHaveProperty('dashboardAlert.active');
      expect(typeof res.body.storageUsageBytes).toBe('number');
    });
  });
});
