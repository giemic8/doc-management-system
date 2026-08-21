import { createHash } from 'crypto';
import { pool } from './db';
import { migrations, Migration } from './migrations';

const MIGRATION_LOCK_ID = 1145914195;

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

function validateRegistry() {
  let previousVersion = 0;
  const names = new Set<string>();

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error(`Migration versions must be unique positive integers in ascending order: ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Migration name must be unique: ${migration.name}`);
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

export async function runMigrations(): Promise<string[]> {
  validateRegistry();
  const client = await pool.connect();
  const newlyApplied: string[] = [];

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1);', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const history = await client.query<AppliedMigration>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version;'
    );
    const registeredVersions = new Set(migrations.map((migration) => migration.version));
    const unknownApplied = history.rows.find((row) => !registeredVersions.has(row.version));
    if (unknownApplied) {
      throw new Error(
        `Database migration ${unknownApplied.version}:${unknownApplied.name} is newer than this application build`
      );
    }
    const appliedByVersion = new Map(history.rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const migrationChecksum = checksum(migration);
      const applied = appliedByVersion.get(migration.version);

      if (applied) {
        if (applied.name !== migration.name || applied.checksum !== migrationChecksum) {
          throw new Error(
            `Applied migration ${migration.version} does not match source; create a new migration instead of editing history`
          );
        }
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3);',
        [migration.version, migration.name, migrationChecksum]
      );
      newlyApplied.push(`${migration.version}:${migration.name}`);
    }

    await client.query('COMMIT');
    return newlyApplied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
