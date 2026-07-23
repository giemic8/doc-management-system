import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Redis from 'ioredis';
import { config } from '../../src/config';
import { checkRateLimit, resetRateLimit } from '../../src/services/rateLimit.service';

const redis = new Redis({ host: config.redisHost, port: config.redisPort });

describe('rateLimit.service', () => {
  const key = 'test:mfa-verify:user-abc';

  beforeEach(async () => {
    await resetRateLimit(key);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('allows attempts under the limit', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit(key, { limit: 5, windowSeconds: 60 });
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks once the limit is exceeded within the window', async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(key, { limit: 5, windowSeconds: 60 });
    }
    const result = await checkRateLimit(key, { limit: 5, windowSeconds: 60 });
    expect(result.allowed).toBe(false);
  });

  it('resets after the window elapses', async () => {
    for (let i = 0; i < 2; i++) {
      await checkRateLimit(key, { limit: 2, windowSeconds: 1 });
    }
    const blocked = await checkRateLimit(key, { limit: 2, windowSeconds: 1 });
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterWindow = await checkRateLimit(key, { limit: 2, windowSeconds: 1 });
    expect(afterWindow.allowed).toBe(true);
  });

  it('tracks different keys independently', async () => {
    const otherKey = 'test:mfa-verify:user-xyz';
    await resetRateLimit(otherKey);

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(key, { limit: 5, windowSeconds: 60 });
    }
    const blockedFirst = await checkRateLimit(key, { limit: 5, windowSeconds: 60 });
    const allowedSecond = await checkRateLimit(otherKey, { limit: 5, windowSeconds: 60 });

    expect(blockedFirst.allowed).toBe(false);
    expect(allowedSecond.allowed).toBe(true);
  });
});
