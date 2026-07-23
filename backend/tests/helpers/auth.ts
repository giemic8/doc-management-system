import request from 'supertest';
import type { Express } from 'express';

export const ADMIN_EMAIL = 'admin@dms.local';
export const ADMIN_PASSWORD = 'admin123';

/** Logs in as the seeded default admin and returns the session token + user. */
export async function loginAsAdmin(app: Express) {
  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`loginAsAdmin failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token as string, user: res.body.user };
}

/** Creates a new editor user directly in the DB and returns their credentials + id. */
export async function createEditor(app: Express, overrides?: { email?: string; password?: string; name?: string }) {
  const { query } = await import('../../src/database/db');
  const bcrypt = await import('bcryptjs');

  const email = overrides?.email ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2)}@dms.local`;
  const password = overrides?.password ?? 'editorPass123';
  const name = overrides?.name ?? 'Test Editor';
  const passwordHash = await bcrypt.hash(password, 10);

  const res = await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'editor') RETURNING id;`,
    [email, passwordHash, name]
  );

  return { id: res.rows[0].id as string, email, password, name };
}

export async function loginAs(app: Express, email: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res;
}
