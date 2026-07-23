import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin } from '../helpers/auth';
import { config } from '../../src/config';

describe('Encryption-at-rest for document storage', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
    config.storageEncryptionEnabled = false;
  });

  it('stores the uploaded file encrypted on disk and serves the original plaintext back', async () => {
    config.storageEncryptionEnabled = true;

    const { token } = await loginAsAdmin(app);
    const plaintext = 'This is the original document content that must never appear in plaintext on disk.';
    const filePath = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(filePath, plaintext);

    const uploadRes = await request(app)
      .post('/api/documents/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath);

    expect(uploadRes.status).toBe(201);
    const doc = uploadRes.body.document;
    expect(doc.is_encrypted).toBe(true);
    expect(doc.encryption_iv).toBeTruthy();
    expect(doc.encryption_auth_tag).toBeTruthy();

    // The file on disk must not contain the plaintext.
    const onDiskBytes = fs.readFileSync(doc.file_path);
    expect(onDiskBytes.includes(plaintext)).toBe(false);

    // But serving it back through the API must return the original plaintext.
    const serveRes = await request(app).get(`/api/documents/${doc.id}/file`).set('Authorization', `Bearer ${token}`);
    expect(serveRes.status).toBe(200);
    expect(serveRes.text).toBe(plaintext);
  });

  it('stores the file unencrypted when encryption is disabled (default)', async () => {
    config.storageEncryptionEnabled = false;

    const { token } = await loginAsAdmin(app);
    const plaintext = 'Plaintext content, encryption disabled.';
    const filePath = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(filePath, plaintext);

    const uploadRes = await request(app)
      .post('/api/documents/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath);

    const doc = uploadRes.body.document;
    expect(doc.is_encrypted).toBe(false);

    const onDiskBytes = fs.readFileSync(doc.file_path, 'utf8');
    expect(onDiskBytes).toBe(plaintext);
  });
});
