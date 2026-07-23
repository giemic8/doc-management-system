import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (config.env === 'development') {
    console.log('Executed query', { text: text.substring(0, 80), duration, rows: res.rowCount });
  }
  return res;
}
