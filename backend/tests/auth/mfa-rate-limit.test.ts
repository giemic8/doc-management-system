import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, ADMIN_EMAIL, ADMIN_PASSWORD } from '../helpers/auth';
import { resetRateLimit } from '../../src/services/rateLimit.service';

async function enrollMfa(token: string) {
  const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const secret = setupRes.body.secret;
  const code = authenticator.generate(secret);
  await request(app).post('/api/auth/mfa/confirm').set('Authorization', `Bearer ${token}`).send({ code });
  return secret;
}

describe('Rate limiting on MFA login challenge verification', () => {
  let adminUserId: string;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    const meRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    // Decode without verifying just to get the id for direct rate-limit reset between tests.
    const payload = JSON.parse(Buffer.from(meRes.body.token.split('.')[1], 'base64').toString());
    adminUserId = payload.id;
    await resetRateLimit(`mfa-verify:${adminUserId}`);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('rejects further attempts once the limit is exceeded, even with a correct code afterwards', async () => {
    const { token: adminToken } = await loginAsAdmin(app);
    const secret = await enrollMfa(adminToken);

    // Exhaust the limit (5 attempts) with wrong codes.
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      const res = await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ challengeToken: loginRes.body.challengeToken, code: '000000' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(401);

    // The 6th attempt, even with the correct code, is rate-limited.
    const loginRes = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const correctCode = authenticator.generate(secret);
    const blockedRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginRes.body.challengeToken, code: correctCode });

    expect(blockedRes.status).toBe(429);
  });
});
