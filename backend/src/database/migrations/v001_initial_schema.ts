import type { Migration } from './index';

export const initialSchema: Migration = {
  version: 1,
  name: 'initial_schema',
  sql: `
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS vector;

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

    CREATE TABLE IF NOT EXISTS org_settings (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

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
      doc_type VARCHAR(100),
      sender VARCHAR(255),
      recipient VARCHAR(255),
      document_date DATE,
      due_date DATE,
      amount NUMERIC(12, 2),
      currency VARCHAR(10) DEFAULT 'EUR',
      summary TEXT,
      ocr_text TEXT,
      version INT NOT NULL DEFAULT 1,
      is_archived BOOLEAN DEFAULT FALSE,
      is_encrypted BOOLEAN NOT NULL DEFAULT false,
      encryption_iv VARCHAR(100),
      encryption_auth_tag VARCHAR(100),
      retention_until DATE,
      legal_hold BOOLEAN NOT NULL DEFAULT false,
      tax_id VARCHAR(50),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding vector(768),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);

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

    CREATE TABLE IF NOT EXISTS tags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) UNIQUE NOT NULL,
      color VARCHAR(30) DEFAULT '#3B82F6',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS custom_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      field_type VARCHAR(50) NOT NULL,
      options JSONB,
      doc_type VARCHAR(100),
      required BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_custom_fields (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      custom_field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
      value_text TEXT,
      value_number NUMERIC(12,2),
      value_date DATE,
      value_boolean BOOLEAN,
      PRIMARY KEY (document_id, custom_field_id)
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      trigger_event VARCHAR(100) NOT NULL,
      condition_json JSONB NOT NULL,
      actions_json JSONB NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP WITH TIME ZONE
    );

    CREATE TABLE IF NOT EXISTS contract_details (
      document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      customer_number VARCHAR(100),
      vendor_address TEXT,
      notice_period_days INT NOT NULL DEFAULT 30,
      cancellation_deadline DATE,
      contract_end_date DATE,
      alert_sent_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(100) NOT NULL,
      details JSONB,
      ip_address VARCHAR(45),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_share_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      token VARCHAR(64) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      expires_at TIMESTAMP WITH TIME ZONE,
      max_downloads INT,
      download_count INT NOT NULL DEFAULT 0,
      failed_attempts INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMP WITH TIME ZONE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMP WITH TIME ZONE
    );

    CREATE TABLE IF NOT EXISTS access_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_access_groups (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS group_tag_permissions (
      group_id UUID NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
      tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      can_read BOOLEAN NOT NULL DEFAULT true,
      can_write BOOLEAN NOT NULL DEFAULT false,
      can_delete BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (group_id, tag_id)
    );
  `,
};
