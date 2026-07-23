import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { app } from '../../src/app';
import { resetDatabase, closeDatabase } from '../helpers/db';
import { loginAsAdmin, createEditor, ADMIN_EMAIL, ADMIN_PASSWORD } from '../helpers/auth';

async function enrollMfa(token: string) {
  const setupRes = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const secret = setupRes.body.secret;
  const code = authenticator.generate(secret);
  await request(app).post('/api/auth/mfa/confirm').set('Authorization', `Bearer ${token}`).send({ code });
  return secret;
}

describe('Rate limiting on MFA login challenge verification', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    // resetDatabase() also clears all rate-limit counters (see helpers/db.ts),
    // which matters here since IP-keyed limits would otherwise leak across
    // test files (supertest requests all originate from the same address).
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('rejects further attempts once the per-user limit is exceeded, even with a correct code afterwards', async () => {
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

  it('rejects further attempts once the per-IP limit is exceeded, even across different target accounts', async () => {
    // Two different editors, MFA-enabled, both attacked from the same source IP
    // (supertest requests all originate from the same local address in tests).
    const editorA = await createEditor(app);
    const loginA = await request(app).post('/api/auth/login').send({ email: editorA.email, password: editorA.password });
    await enrollMfa(loginA.body.token);

    const editorB = await createEditor(app);
    const loginB = await request(app).post('/api/auth/login').send({ email: editorB.email, password: editorB.password });
    await enrollMfa(loginB.body.token);

    // Spread 5 wrong attempts across both accounts from the same IP.
    for (let i = 0; i < 5; i++) {
      const email = i % 2 === 0 ? editorA.email : editorB.email;
      const password = i % 2 === 0 ? editorA.password : editorB.password;
      const loginRes = await request(app).post('/api/auth/login').send({ email, password });
      await request(app)
        .post('/api/auth/mfa/verify-login')
        .send({ challengeToken: loginRes.body.challengeToken, code: '000000' });
    }

    // A 6th attempt against a fresh account from the same IP is blocked by the
    // IP-wide limit even though that account's own per-user limit is untouched.
    const editorC = await createEditor(app);
    const loginC = await request(app).post('/api/auth/login').send({ email: editorC.email, password: editorC.password });
    await enrollMfa(loginC.body.token);

    const loginAttempt = await request(app).post('/api/auth/login').send({ email: editorC.email, password: editorC.password });
    const blockedRes = await request(app)
      .post('/api/auth/mfa/verify-login')
      .send({ challengeToken: loginAttempt.body.challengeToken, code: '000000' });

    expect(blockedRes.status).toBe(429);
  });
});
