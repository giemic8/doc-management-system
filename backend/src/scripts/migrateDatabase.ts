import { pool } from '../database/db';
import { runMigrations } from '../database/migrator';

async function main() {
  try {
    const applied = await runMigrations();
    console.log(applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database already up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
});
