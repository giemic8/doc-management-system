import { query } from './db';
import bcrypt from 'bcryptjs';

export async function initDatabase() {
  console.log('Initializing database tables & extensions...');
  
  // Enable extensions if supported
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  } catch (err) {
    console.warn('Notice: vector or uuid extension creation warning (pgvector may not be installed locally yet):', err);
  }

  // Users table
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'editor',
      mfa_enabled BOOLEAN NOT NULL DEFAULT false,
      totp_secret_encrypted VARCHAR(500),
      mfa_backup_codes JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Idempotent column additions for pre-existing databases created before MFA.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted VARCHAR(500);`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes JSONB;`);

  // Email import config (Ticket #8)
  await query(`
    CREATE TABLE IF NOT EXISTS email_import_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host VARCHAR(255) NOT NULL,
      port INT NOT NULL DEFAULT 993,
      secure BOOLEAN NOT NULL DEFAULT true,
      username VARCHAR(255) NOT NULL,
      password_encrypted VARCHAR(500) NOT NULL,
      poll_interval_minutes INT NOT NULL DEFAULT 5,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_polled_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Org-wide settings (single-row key/value table).
  await query(`
    CREATE TABLE IF NOT EXISTS org_settings (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Document text chunks + embeddings (Ticket #4 — hybrid semantic search)
  await query(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding vector(768),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);`);

  // Webhook endpoints (Ticket #3)
  await query(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url VARCHAR(2000) NOT NULL,
      secret VARCHAR(255) NOT NULL,
      events JSONB NOT NULL DEFAULT '[]',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      webhook_endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      success BOOLEAN NOT NULL,
      attempts INT NOT NULL,
      last_status INT,
      last_error TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Documents table
  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(500) NOT NULL,
      original_filename VARCHAR(500) NOT NULL,
      file_path VARCHAR(1000) NOT NULL,
      derived_file_path VARCHAR(1000),
      thumbnail_path VARCHAR(1000),
      file_size BIGINT NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      
      -- AI Extracted Metadata
      doc_type VARCHAR(100),
      sender VARCHAR(255),
      recipient VARCHAR(255),
      document_date DATE,
      due_date DATE,
      amount NUMERIC(12, 2),
      currency VARCHAR(10) DEFAULT 'EUR',
      summary TEXT,
      ocr_text TEXT,
      
      -- Flags & Security
      version INT NOT NULL DEFAULT 1,
      is_archived BOOLEAN DEFAULT FALSE,
      is_encrypted BOOLEAN NOT NULL DEFAULT false,
      encryption_iv VARCHAR(100),
      encryption_auth_tag VARCHAR(100),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN NOT NULL DEFAULT false;`);
  await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS encryption_iv VARCHAR(100);`);
  await query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS encryption_auth_tag VARCHAR(100);`);

  // Document Versions (Revision history)
  await query(`
    CREATE TABLE IF NOT EXISTS document_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INT NOT NULL,
      file_path VARCHAR(1000) NOT NULL,
      file_size BIGINT NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      changes_summary TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Tags
  await query(`
    CREATE TABLE IF NOT EXISTS tags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) UNIQUE NOT NULL,
      color VARCHAR(30) DEFAULT '#3B82F6',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Document Tags (Many-to-many)
  await query(`
    CREATE TABLE IF NOT EXISTS document_tags (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, tag_id)
    );
  `);

  // Custom Fields Schema
  await query(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      field_type VARCHAR(50) NOT NULL, -- string, number, date, boolean, dropdown
      options JSONB,
      doc_type VARCHAR(100),
      required BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await query(`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS doc_type VARCHAR(100);`);
  await query(`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS required BOOLEAN NOT NULL DEFAULT false;`);

  // Document Custom Field Values
  await query(`
    CREATE TABLE IF NOT EXISTS document_custom_fields (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      custom_field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
      value_text TEXT,
      value_number NUMERIC(12,2),
      value_date DATE,
      value_boolean BOOLEAN,
      PRIMARY KEY (document_id, custom_field_id)
    );
  `);

  // Workflows
  await query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      trigger_event VARCHAR(100) NOT NULL, -- e.g. 'on_ingest', 'on_tag'
      condition_json JSONB NOT NULL,
      actions_json JSONB NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Audit Log (Revision security & tracking)
  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      details JSONB,
      ip_address VARCHAR(45),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed Admin user if none exists
  const existingUsers = await query(`SELECT COUNT(*) FROM users;`);
  if (parseInt(existingUsers.rows[0].count, 10) === 0) {
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    await query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4);`,
      ['admin@dms.local', adminPasswordHash, 'Administrator', 'admin']
    );
    console.log('Seeded default admin user: admin@dms.local / admin123');
  }

  // Seed default tags
  const existingTags = await query(`SELECT COUNT(*) FROM tags;`);
  if (parseInt(existingTags.rows[0].count, 10) === 0) {
    await query(`
      INSERT INTO tags (name, color) VALUES 
      ('Finanzen', '#10B981'),
      ('Rechnung', '#EF4444'),
      ('Vertrag', '#8B5CF6'),
      ('Steuern', '#F59E0B'),
      ('Versicherung', '#3B82F6'),
      ('Wichtig', '#EC4899');
    `);
    console.log('Seeded default tags.');
  }

  console.log('Database initialization completed successfully.');
}
