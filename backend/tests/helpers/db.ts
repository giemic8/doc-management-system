import { query, pool } from '../../src/database/db';
import { initDatabase } from '../../src/database/schema';
import Redis from 'ioredis';
import { config } from '../../src/config';

let redis: Redis | null = null;

function getTestRedis(): Redis {
  if (!redis) {
    redis = new Redis({ host: config.redisHost, port: config.redisPort });
  }
  return redis;
}

/**
 * Applies migrations and truncates application tables so each test file starts
 * from a clean slate. Migration history survives. Then re-seeds the development
 * admin and reference tags. Also clears rate-limit counters, since
 * IP-keyed limits would otherwise leak across test files (supertest
 * requests all originate from the same local address).
 */
export async function resetDatabase() {
  await initDatabase();

  await query(`
    TRUNCATE TABLE
      audit_logs,
      document_custom_fields,
      document_tags,
      document_chunks,
      document_versions,
      documents,
      custom_fields,
      workflows,
      tags,
      org_settings,
      webhook_deliveries,
      webhook_endpoints,
      email_import_config,
      access_groups,
      users
    RESTART IDENTITY CASCADE;
  `);

  // Re-run idempotent reference/development seeds.
  await initDatabase();

  await clearRateLimits();
}

async function clearRateLimits() {
  const client = getTestRedis();
  const keys = await client.keys('ratelimit:*');
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

export async function closeDatabase() {
  await pool.end();
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
