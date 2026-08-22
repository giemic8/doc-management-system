import Redis from 'ioredis';
import { config } from '../config';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({ host: config.redisHost, port: config.redisPort });
  }
  return redis;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Fixed-window rate limiter backed by Redis, so the limit is enforced
 * consistently across backend instances/restarts. Each call increments the
 * counter for `key`; the counter's TTL is (re)set only on the first
 * increment of a window so the window doesn't slide forward on every call.
 */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const client = getRedis();
  const redisKey = `ratelimit:${key}`;

  const count = await client.incr(redisKey);
  if (count === 1) {
    await client.expire(redisKey, options.windowSeconds);
  }

  const allowed = count <= options.limit;
  const remaining = Math.max(0, options.limit - count);

  return { allowed, remaining };
}

export async function resetRateLimit(key: string): Promise<void> {
  const client = getRedis();
  await client.del(`ratelimit:${key}`);
}

/**
 * Ticket #37 -- a real round trip to Redis for the operations health probe.
 * Lives here because this module already owns the Redis client; the health
 * service must not open a second connection of its own just to ask whether
 * the first one would work. Rejects when Redis is unreachable, which is the
 * signal the probe is after.
 */
export async function pingRedis(): Promise<string> {
  const client = getRedis();
  return client.ping();
}
