import { query, pool } from '../../src/database/db';
import { initDatabase } from '../../src/database/schema';

/**
 * Ensures schema exists and truncates all tables so each test file starts
 * from a clean slate. Re-seeds the default admin + tags (schema.ts seeds
 * only when tables are empty).
 */
export async function resetDatabase() {
  await initDatabase();

  await query(`
    TRUNCATE TABLE
      audit_logs,
      document_custom_fields,
      document_tags,
      document_versions,
      documents,
      custom_fields,
      workflows,
      tags,
      users
    RESTART IDENTITY CASCADE;
  `);

  // Re-run seeding logic (schema.ts only seeds when tables are empty).
  await initDatabase();
}

export async function closeDatabase() {
  await pool.end();
}
