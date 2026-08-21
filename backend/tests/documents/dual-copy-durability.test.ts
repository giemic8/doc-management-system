import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Dual-copy durability read path (Ticket #31)', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it('serves the file from the replica and self-heals the primary when the primary copy goes missing', async () => {
    const { token } = await loginAsAdmin(app);
    const plaintext = 'Content that must survive losing the primary copy.';
    const filePath = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(filePath, plaintext);

    const uploadRes = await request(app)
      .post('/api/documents/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath);

    expect(uploadRes.status).toBe(201);
    const doc = uploadRes.body.document;
    expect(doc.replica_file_path).toBeTruthy();
    expect(fs.existsSync(doc.replica_file_path)).toBe(true);

    // Simulate the primary disk losing the file.
    fs.unlinkSync(doc.file_path);
    expect(fs.existsSync(doc.file_path)).toBe(false);

    const serveRes = await request(app).get(`/api/documents/${doc.id}/file`).set('Authorization', `Bearer ${token}`);
    expect(serveRes.status).toBe(200);
    expect(serveRes.text).toBe(plaintext);

    await waitUntil(() => fs.existsSync(doc.file_path));
    expect(fs.existsSync(doc.file_path)).toBe(true);
    expect(fs.readFileSync(doc.file_path, 'utf8')).toBe(plaintext);
  });

  it('still 404s when neither copy is available', async () => {
    const { token } = await loginAsAdmin(app);
    const filePath = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(filePath, 'both copies gone');

    const uploadRes = await request(app)
      .post('/api/documents/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath);

    const doc = uploadRes.body.document;
    fs.unlinkSync(doc.file_path);
    fs.unlinkSync(doc.replica_file_path);

    const serveRes = await request(app).get(`/api/documents/${doc.id}/file`).set('Authorization', `Bearer ${token}`);
    expect(serveRes.status).toBe(404);
  });
});
