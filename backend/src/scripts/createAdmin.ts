import bcrypt from 'bcryptjs';
import { pool, query } from '../database/db';
import { runMigrations } from '../database/migrator';
import { seedDatabase } from '../database/seed';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || 'Administrator';

  if (!email || !email.includes('@')) {
    throw new Error('ADMIN_EMAIL must contain a valid email address');
  }
  if (!password || password.length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
  }

  await runMigrations();
  await seedDatabase('production');
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id;`,
    [email, passwordHash, name]
  );

  if (result.rowCount !== 1) {
    throw new Error(`User already exists: ${email}`);
  }
  console.log(`Created administrator: ${email}`);
}

main()
  .catch((error) => {
    console.error('Administrator creation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
