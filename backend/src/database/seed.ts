import bcrypt from 'bcryptjs';
import { config } from '../config';
import { query } from './db';

const defaultTags = [
  ['Finanzen', '#10B981'],
  ['Rechnung', '#EF4444'],
  ['Vertrag', '#8B5CF6'],
  ['Steuern', '#F59E0B'],
  ['Versicherung', '#3B82F6'],
  ['Wichtig', '#EC4899'],
] as const;

export async function seedDatabase(environment = config.env) {
  for (const [name, color] of defaultTags) {
    await query(
      `INSERT INTO tags (name, color) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING;`,
      [name, color]
    );
  }

  if (environment === 'production') {
    return;
  }

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, name, role)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM users)
     ON CONFLICT (email) DO NOTHING
     RETURNING id;`,
    ['admin@dms.local', adminPasswordHash, 'Administrator', 'admin']
  );

  if (result.rowCount === 1) {
    console.log('Seeded development admin user: admin@dms.local / admin123');
  }
}
