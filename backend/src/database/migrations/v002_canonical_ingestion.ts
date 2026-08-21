import type { Migration } from './index';

export const canonicalIngestion: Migration = {
  version: 2,
  name: 'canonical_ingestion',
  sql: `
    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS ingestion_source VARCHAR(20),
      ADD COLUMN IF NOT EXISTS ingestion_key VARCHAR(500),
      ADD COLUMN IF NOT EXISTS failure_reason TEXT,
      ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_transition_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

    UPDATE documents
    SET status = CASE
      WHEN status = 'processed' THEN 'ready'
      WHEN status IN ('pending', 'processing') THEN 'processing'
      ELSE 'failed'
    END,
    failure_reason = CASE
      WHEN status NOT IN ('processed', 'pending', 'processing')
        THEN 'Legacy document had unsupported status: ' || status
      ELSE failure_reason
    END;

    ALTER TABLE documents
      ALTER COLUMN status SET DEFAULT 'received',
      ADD CONSTRAINT documents_ingestion_source_check
        CHECK (ingestion_source IS NULL OR ingestion_source IN ('browser', 'watchfolder', 'email')),
      ADD CONSTRAINT documents_status_check
        CHECK (status IN ('received', 'durable', 'processing', 'review', 'ready', 'failed', 'trashed')),
      ADD CONSTRAINT documents_processing_attempts_check
        CHECK (processing_attempts >= 0);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_ingestion_identity
      ON documents (ingestion_source, ingestion_key)
      WHERE ingestion_source IS NOT NULL AND ingestion_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_documents_processing_poll
      ON documents (status, last_transition_at)
      WHERE status = 'processing';

    CREATE TABLE IF NOT EXISTS document_state_transitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      from_state VARCHAR(50),
      to_state VARCHAR(50) NOT NULL,
      reason TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_document_state_transitions_document
      ON document_state_transitions (document_id, created_at);

    CREATE OR REPLACE FUNCTION transition_document(
      p_document_id UUID,
      p_to_state VARCHAR(50),
      p_reason TEXT DEFAULT NULL
    ) RETURNS SETOF documents AS $$
    DECLARE
      current_state VARCHAR(50);
      transition_allowed BOOLEAN;
    BEGIN
      SELECT status INTO current_state
      FROM documents
      WHERE id = p_document_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Document % not found', p_document_id USING ERRCODE = 'P0002';
      END IF;

      IF current_state = p_to_state THEN
        RETURN QUERY SELECT * FROM documents WHERE id = p_document_id;
        RETURN;
      END IF;

      transition_allowed := CASE current_state
        WHEN 'received' THEN p_to_state IN ('durable', 'failed')
        WHEN 'durable' THEN p_to_state IN ('processing', 'failed')
        WHEN 'processing' THEN p_to_state IN ('review', 'ready', 'failed')
        WHEN 'review' THEN p_to_state IN ('processing', 'ready', 'trashed')
        WHEN 'ready' THEN p_to_state IN ('processing', 'review', 'trashed')
        WHEN 'failed' THEN p_to_state IN ('received', 'processing', 'trashed')
        ELSE FALSE
      END;

      IF NOT transition_allowed THEN
        RAISE EXCEPTION 'Invalid document transition: % -> %', current_state, p_to_state
          USING ERRCODE = '22023';
      END IF;

      IF p_to_state = 'failed' AND NULLIF(BTRIM(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'Failure transition requires a reason' USING ERRCODE = '22023';
      END IF;

      UPDATE documents
      SET status = p_to_state,
          failure_reason = CASE WHEN p_to_state = 'failed' THEN p_reason ELSE NULL END,
          processing_attempts = processing_attempts + CASE WHEN p_to_state = 'processing' THEN 1 ELSE 0 END,
          last_transition_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = p_document_id;

      INSERT INTO document_state_transitions (document_id, from_state, to_state, reason)
      VALUES (p_document_id, current_state, p_to_state, p_reason);

      RETURN QUERY SELECT * FROM documents WHERE id = p_document_id;
    END;
    $$ LANGUAGE plpgsql;
  `,
};
