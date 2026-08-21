import { runMigrations } from './migrator';
import { seedDatabase } from './seed';

/**
 * Compatibility facade used by application startup and integration tests.
 * Schema changes belong in database/migrations; seeds stay separate from DDL.
 */
export async function initDatabase() {
  const applied = await runMigrations();
  await seedDatabase();

  if (applied.length > 0) {
    console.log(`Applied database migrations: ${applied.join(', ')}`);
  }
}
