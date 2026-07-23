import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, ADMIN_PASSWORD } from '../helpers/auth';

describe('MFA enrollment', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET /api/auth/mfa/status', () => {
    it('reports MFA disabled for a fresh account', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mfaEnabled: false, backupCodesRemaining: 0 });
    });

    it('requires authentication', async () => {
      const res = await request(app).get('/api/auth/mfa/status');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/mfa/setup', () => {
    it('returns a QR code data URL and a manual-entry secret', async () => {
      const { token } = await loginAsAdmin(app);

      const res = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(res.body.secret).toMatch(/^[A-Z2-7]+=*$/);
    });

    it('does not enable MFA until confirmed', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);

      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body.mfaEnabled).toBe(false);
    });

    it('requires the current password to restart setup once MFA is already enabled', async () => {
      const { token } = await loginAsAdmin(app);
      const firstSetup = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
      const firstCode = authenticator.generate(firstSetup.body.secret);
      await request(app).post('/api/auth/mfa/confirm').set('Authorization', `Bearer ${token}`).send({ code: firstCode });

      // A session token alone (no password) can't be used to stage a takeover
      // of an already-enrolled account.
      const noPasswordRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
      expect(noPasswordRes.status).toBe(401);

      const wrongPasswordRes = await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'wrong-password' });
      expect(wrongPasswordRes.status).toBe(401);

      // MFA is still enabled and untouched throughout.
      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body.mfaEnabled).toBe(true);

      const correctPasswordRes = await request(app)
        .post('/api/auth/mfa/setup')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: ADMIN_PASSWORD });
      expect(correctPasswordRes.status).toBe(200);
    });
  });

  describe('POST /api/auth/mfa/confirm', () => {
    it('activates MFA and returns backup codes when the code is correct', async () => {
      const { token } = await loginAsAdmin(app);
      const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
      const code = authenticator.generate(setupRes.body.secret);

      const confirmRes = await request(app)
        .post('/api/auth/mfa/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ code });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.backupCodes).toHaveLength(10);
      confirmRes.body.backupCodes.forEach((c: string) => expect(c).toMatch(/^\d{8}$/));

      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body).toMatchObject({ mfaEnabled: true, backupCodesRemaining: 10 });
    });

    it('rejects an incorrect code and does not activate MFA', async () => {
      const { token } = await loginAsAdmin(app);
      await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);

      const confirmRes = await request(app)
        .post('/api/auth/mfa/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '000000' });

      expect(confirmRes.status).toBe(400);

      const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${token}`);
      expect(status.body.mfaEnabled).toBe(false);
    });

    it('rejects confirm when no setup was started', async () => {
      const { token } = await loginAsAdmin(app);

      const confirmRes = await request(app)
        .post('/api/auth/mfa/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '123456' });

      expect(confirmRes.status).toBe(400);
    });
  });
});
