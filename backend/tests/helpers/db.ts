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
      emergency_access_requests,
      space_trusted_contacts,
      space_members,
      spaces,
      user_recovery_codes,
      document_extractions,
      review_items,
      document_duplicate_links,
      review_settings,
      ops_alert_deliveries,
      ops_incidents,
      ops_component_health,
      ops_alert_settings,
      users
    RESTART IDENTITY CASCADE;
  `);

  // Ticket #35 -- the thresholds are a singleton row seeded by the migration,
  // and TRUNCATE ... CASCADE takes it with the users it references. Put it
  // back at its defaults so every test file starts from the documented bar.
  await query(`INSERT INTO review_settings (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;`);

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
