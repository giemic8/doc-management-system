import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../src/database/db';
import { runMigrations } from '../../src/database/migrator';
import { resetDevelopmentDatabase } from '../../src/database/reset';
import { seedDatabase } from '../../src/database/seed';

describe('database migrations', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('builds the complete schema from an empty database and records history', async () => {
    const client = await pool.connect();
    try {
      await client.query('DROP SCHEMA public CASCADE;');
      await client.query('CREATE SCHEMA public;');
    } finally {
      client.release();
    }

    await expect(runMigrations()).resolves.toEqual(['1:initial_schema', '2:canonical_ingestion']);

    const history = await query(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version;'
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows[0]).toMatchObject({ version: 1, name: 'initial_schema' });
    expect(history.rows[1]).toMatchObject({ version: 2, name: 'canonical_ingestion' });
    for (const migration of history.rows) {
      expect(migration.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(migration.applied_at).toBeTruthy();
    }

    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;`
    );
    const tableNames = tables.rows.map((row) => row.tablename);
    expect(tableNames).toHaveLength(22);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'documents',
        'document_chunks',
        'document_state_transitions',
        'users',
        'schema_migrations',
      ])
    );

    const vectorExtension = await query(`SELECT extname FROM pg_extension WHERE extname = 'vector';`);
    expect(vectorExtension.rows).toHaveLength(1);
  });

  it('is idempotent and preserves migration history', async () => {
    await expect(runMigrations()).resolves.toEqual([]);
    const result = await query('SELECT COUNT(*)::int AS count FROM schema_migrations;');
    expect(result.rows[0].count).toBe(2);
  });

  it('rejects a database migrated by a newer application build', async () => {
    await query(
      `INSERT INTO schema_migrations (version, name, checksum)
       VALUES (999, 'future_schema', $1);`,
      ['0'.repeat(64)]
    );
    await expect(runMigrations()).rejects.toThrow(
      'Database migration 999:future_schema is newer than this application build'
    );
    await query('DELETE FROM schema_migrations WHERE version = 999;');
  });

  it('seeds reference tags but no default administrator in production', async () => {
    await seedDatabase('production');
    const users = await query('SELECT COUNT(*)::int AS count FROM users;');
    const tags = await query('SELECT COUNT(*)::int AS count FROM tags;');
    expect(users.rows[0].count).toBe(0);
    expect(tags.rows[0].count).toBe(6);
  });

  it('seeds the development administrator outside production', async () => {
    await seedDatabase('test');
    const result = await query(`SELECT email, role FROM users WHERE email = 'admin@dms.local';`);
    expect(result.rows).toEqual([{ email: 'admin@dms.local', role: 'admin' }]);
  });

  it('refuses destructive reset in production before touching the database', async () => {
    await expect(resetDevelopmentDatabase('production', 'dms_db_test')).rejects.toThrow(
      'Database reset is allowed only when NODE_ENV=development or NODE_ENV=test'
    );
    const result = await query('SELECT COUNT(*)::int AS count FROM schema_migrations;');
    expect(result.rows[0].count).toBe(2);
  });

  it('requires the configured database name before resetting', async () => {
    await expect(resetDevelopmentDatabase('test', 'wrong_database')).rejects.toThrow(
      'Database reset requires --confirm=dms_db_test'
    );
  });

  it('resets a confirmed test database, reapplies migrations, and re-seeds it', async () => {
    await resetDevelopmentDatabase('test', 'dms_db_test');

    const migrations = await query('SELECT version, name FROM schema_migrations ORDER BY version;');
    const users = await query(`SELECT email, role FROM users WHERE email = 'admin@dms.local';`);
    const tags = await query('SELECT COUNT(*)::int AS count FROM tags;');

    expect(migrations.rows).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'canonical_ingestion' },
    ]);
    expect(users.rows).toEqual([{ email: 'admin@dms.local', role: 'admin' }]);
    expect(tags.rows[0].count).toBe(6);
  });
});
