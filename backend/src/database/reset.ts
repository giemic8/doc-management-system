import { config } from '../config';
import { pool } from './db';
import { initDatabase } from './schema';

export async function resetDevelopmentDatabase(
  environment = config.env,
  confirmedDatabaseName?: string
) {
  if (environment !== 'development' && environment !== 'test') {
    throw new Error('Database reset is allowed only when NODE_ENV=development or NODE_ENV=test');
  }

  const targetDatabaseName = decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1));
  if (!targetDatabaseName || confirmedDatabaseName !== targetDatabaseName) {
    throw new Error(
      `Database reset requires --confirm=${targetDatabaseName} to match the configured database name`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP SCHEMA public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await initDatabase();
}
