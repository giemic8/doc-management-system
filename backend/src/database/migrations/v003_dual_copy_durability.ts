import type { Migration } from './index';

export const dualCopyDurability: Migration = {
  version: 3,
  name: 'dual_copy_durability',
  sql: `
    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS replica_file_path VARCHAR(1000),
      ADD COLUMN IF NOT EXISTS replica_verified_at TIMESTAMP WITH TIME ZONE;

    CREATE INDEX IF NOT EXISTS idx_documents_file_hash_durable
      ON documents (file_hash)
      WHERE replica_verified_at IS NOT NULL AND status != 'failed';
  `,
};
