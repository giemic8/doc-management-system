import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor } from '../helpers/auth';

async function enrollMfa(token: string) {
  const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const secret = setupRes.body.secret;
  const code = authenticator.generate(secret);
  await request(app).post('/api/auth/mfa/confirm').set('Authorization', `Bearer ${token}`).send({ code });
}

describe('Admin-enforced org-wide MFA requirement', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET/PUT /api/admin/settings/mfa-required', () => {
    it('defaults to not required', async () => {
      const { token } = await loginAsAdmin(app);
      const res = await request(app).get('/api/admin/settings/mfa-required').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.required).toBe(false);
    });

    it('rejects a non-admin trying to toggle the setting', async () => {
      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      const res = await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${loginRes.body.token}`)
        .send({ required: true });

      expect(res.status).toBe(403);
    });

    it('allows an admin to enable and disable the setting', async () => {
      const { token } = await loginAsAdmin(app);

      const enableRes = await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${token}`)
        .send({ required: true });
      expect(enableRes.status).toBe(200);

      const statusRes = await request(app).get('/api/admin/settings/mfa-required').set('Authorization', `Bearer ${token}`);
      expect(statusRes.body.required).toBe(true);

      const disableRes = await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${token}`)
        .send({ required: false });
      expect(disableRes.status).toBe(200);

      const statusRes2 = await request(app).get('/api/admin/settings/mfa-required').set('Authorization', `Bearer ${token}`);
      expect(statusRes2.body.required).toBe(false);
    });
  });

  describe('enforcement at login', () => {
    it('routes an editor without MFA to setup instead of issuing a token, once enforcement is on', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: true });

      const editor = await createEditor(app);
      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.token).toBeUndefined();
      expect(loginRes.body.mfaSetupRequired).toBe(true);
      expect(loginRes.body.challengeToken).toBeTypeOf('string');
    });

    it('still uses the normal MFA challenge (not setup) for an editor who already has MFA enabled', async () => {
      const editor = await createEditor(app);
      const preEnforcementLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: editor.email, password: editor.password });
      await enrollMfa(preEnforcementLogin.body.token);

      const { token: adminToken } = await loginAsAdmin(app);
      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: true });

      const loginRes = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });

      expect(loginRes.body.mfaRequired).toBe(true);
      expect(loginRes.body.mfaSetupRequired).toBeUndefined();
    });

    it('does not affect admin accounts even when enforcement is on', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: true });

      const loginRes = await request(app).post('/api/auth/login').send({ email: 'admin@dms.local', password: 'admin123' });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.token).toBeTypeOf('string');
      expect(loginRes.body.mfaSetupRequired).toBeUndefined();
    });
  });

  describe('disable blocked while enforcement is active', () => {
    it('prevents an editor from disabling MFA while org-wide enforcement is on', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const editor = await createEditor(app);

      // Enroll the editor in MFA while enforcement is still off.
      const editorLogin = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });
      await enrollMfa(editorLogin.body.token);

      // Now admin turns on enforcement.
      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: true });

      const disableRes = await request(app)
        .post('/api/auth/mfa/disable')
        .set('Authorization', `Bearer ${editorLogin.body.token}`)
        .send({ password: editor.password });

      expect(disableRes.status).toBe(403);
    });

    it('allows disabling again once enforcement is turned off', async () => {
      const { token: adminToken } = await loginAsAdmin(app);
      const editor = await createEditor(app);
      const editorLogin = await request(app).post('/api/auth/login').send({ email: editor.email, password: editor.password });
      await enrollMfa(editorLogin.body.token);

      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: true });
      await request(app)
        .put('/api/admin/settings/mfa-required')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ required: false });

      const disableRes = await request(app)
        .post('/api/auth/mfa/disable')
        .set('Authorization', `Bearer ${editorLogin.body.token}`)
        .send({ password: editor.password });

      expect(disableRes.status).toBe(200);
    });
  });
});
