import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, ADMIN_EMAIL, ADMIN_PASSWORD } from '../helpers/auth';

async function enrollMfa(token: string) {
  const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const secret = setupRes.body.secret;
  const code = authenticator.generate(secret);
  const confirmRes = await request(app)
    .post('/api/auth/mfa/confirm')
    .set('Authorization', `Bearer ${token}`)
    .send({ code });
  return { secret, backupCodes: confirmRes.body.backupCodes as string[] };
}

describe('MFA disable & backup code regeneration', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/auth/mfa/disable', () => {
    it('disables MFA when the correct password is provided', async () => {
      const { token } = await loginAsAdmin(app);
      await enrollMfa(token);

      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: ADMIN_PASSWORD });

      expect(res.status).toBe(200);

      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body.mfaEnabled).toBe(false);

      // Login now behaves single-step again.
      const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(loginRes.body.token).toBeTypeOf('string');
      expect(loginRes.body.mfaRequired).toBeUndefined();
    });

    it('rejects disable with an incorrect password and leaves MFA enabled', async () => {
      const { token } = await loginAsAdmin(app);
      await enrollMfa(token);

      const res = await request(app)
        .post('/api/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'wrong-password' });

      expect(res.status).toBe(401);

      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body.mfaEnabled).toBe(true);
    });
  });

  describe('POST /api/auth/mfa/backup-codes/regenerate', () => {
    it('invalidates old codes and returns a fresh set when the password is correct', async () => {
      const { token } = await loginAsAdmin(app);
      const { backupCodes: oldCodes } = await enrollMfa(token);

      const res = await request(app)
        .post('/api/auth/mfa/backup-codes/regenerate')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: ADMIN_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.backupCodes).toHaveLength(10);
      expect(res.body.backupCodes).not.toEqual(oldCodes);

      // Old code no longer works at login.
      const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      const verifyRes = await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ challengeToken: loginRes.body.challengeToken, code: oldCodes[0] });
      expect(verifyRes.status).toBe(401);

      // New code works.
      const loginRes2 = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      const verifyRes2 = await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ challengeToken: loginRes2.body.challengeToken, code: res.body.backupCodes[0] });
      expect(verifyRes2.status).toBe(200);
    });

    it('rejects regeneration with an incorrect password and leaves old codes valid', async () => {
      const { token } = await loginAsAdmin(app);
      const { backupCodes: oldCodes } = await enrollMfa(token);

      const res = await request(app)
        .post('/api/auth/mfa/backup-codes/regenerate')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'wrong-password' });

      expect(res.status).toBe(401);

      const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      const verifyRes = await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ challengeToken: loginRes.body.challengeToken, code: oldCodes[0] });
      expect(verifyRes.status).toBe(200);
    });
  });
});
