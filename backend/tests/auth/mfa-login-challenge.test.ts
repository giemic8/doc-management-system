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

describe('Two-step login with MFA', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('logs in normally (single step) when MFA is not enabled', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.mfaRequired).toBeUndefined();
  });

  it('returns a challenge instead of a token once MFA is enabled', async () => {
    const { token: adminToken } = await loginAsAdmin(app);
    await enrollMfa(adminToken);

    const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.challengeToken).toBeTypeOf('string');
  });

  it('exchanges the challenge + correct TOTP code for a session token', async () => {
    const { token: adminToken } = await loginAsAdmin(app);
    const { secret } = await enrollMfa(adminToken);

    const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const code = authenticator.generate(secret);

    const verifyRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginRes.body.challengeToken, code });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTypeOf('string');
  });

  it('exchanges the challenge + a correct unused backup code for a session token, then marks it used', async () => {
    const { token: adminToken } = await loginAsAdmin(app);
    const { backupCodes } = await enrollMfa(adminToken);

    const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const backupCode = backupCodes[0];

    const verifyRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginRes.body.challengeToken, code: backupCode });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTypeOf('string');

    // Reusing the same backup code must fail.
    const loginRes2 = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const reuseRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginRes2.body.challengeToken, code: backupCode });

    expect(reuseRes.status).toBe(401);
  });

  it('rejects an incorrect code with a generic error', async () => {
    const { token: adminToken } = await loginAsAdmin(app);
    await enrollMfa(adminToken);

    const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    const verifyRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginRes.body.challengeToken, code: '000000' });

    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.error).toBeTypeOf('string');
  });

  it('rejects a verify-login call with an invalid/expired challenge token', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: 'not-a-real-token', code: '123456' });

    expect(res.status).toBe(401);
  });
});
