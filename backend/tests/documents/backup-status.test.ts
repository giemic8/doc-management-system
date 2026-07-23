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
        timestamp: '2026-07-23T02:00:00Z',
        dbBackupSizeBytes: 1024,
        storageBackupSizeBytes: 2048,
        success: true,
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
      expect(typeof res.body.storageUsageBytes).toBe('number');
    });
  });
});
