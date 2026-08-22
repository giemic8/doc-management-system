import type { Migration } from './index';

/**
 * Ticket #33 -- 90-day trash and controlled purge.
 *
 * `trashed` already existed as a lifecycle state (v002), but nothing ever
 * entered it: deletion removed the row outright. This migration turns
 * `trashed` into a real, reversible state:
 *
 * - `pre_trash_status` records where the document came from, so a restore
 *   returns it to exactly that state instead of guessing `ready`. It is
 *   also the transition guard: the ONLY way out of `trashed` is back into
 *   the recorded state.
 * - `purge_after` materializes the 90-day recovery window at trash time,
 *   so the deadline stays stable even if the policy changes later, and the
 *   purge-eligibility query stays a plain index scan.
 * - Every non-trashed state may now enter `trashed`: a user deleting a
 *   document that is still ingesting or processing is a normal action, not
 *   an error. The worker tolerates a document disappearing from
 *   `processing` mid-flight (see worker/src/worker.py).
 */
export const trashAndPurge: Migration = {
  version: 4,
  name: 'trash_and_purge',
  sql: `
    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS trashed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS purge_after TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS pre_trash_status VARCHAR(50);

    CREATE INDEX IF NOT EXISTS idx_documents_trash_window
      ON documents (purge_after)
      WHERE status = 'trashed';

    CREATE OR REPLACE FUNCTION transition_document(
      p_document_id UUID,
      p_to_state VARCHAR(50),
      p_reason TEXT DEFAULT NULL
    ) RETURNS SETOF documents AS $$
    DECLARE
      current_state VARCHAR(50);
      restore_state VARCHAR(50);
      transition_allowed BOOLEAN;
    BEGIN
      SELECT status, pre_trash_status INTO current_state, restore_state
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
        WHEN 'received' THEN p_to_state IN ('durable', 'failed', 'trashed')
        WHEN 'durable' THEN p_to_state IN ('processing', 'failed', 'trashed')
        WHEN 'processing' THEN p_to_state IN ('review', 'ready', 'failed', 'trashed')
        WHEN 'review' THEN p_to_state IN ('processing', 'ready', 'trashed')
        WHEN 'ready' THEN p_to_state IN ('processing', 'review', 'trashed')
        WHEN 'failed' THEN p_to_state IN ('received', 'processing', 'trashed')
        -- Restore is the only exit from the trash, and it leads back to
        -- the state the document held when it was trashed. Older rows
        -- without a recorded pre-trash state fall back to 'ready'.
        WHEN 'trashed' THEN p_to_state = COALESCE(restore_state, 'ready')
        ELSE FALSE
      END;

      IF NOT transition_allowed THEN
        RAISE EXCEPTION 'Invalid document transition: % -> %', current_state, p_to_state
          USING ERRCODE = '22023';
      END IF;

      -- Restoring a document that was failed when it was trashed hands the
      -- stored reason back; only a genuinely new failure needs one supplied.
      IF p_to_state = 'failed' AND current_state <> 'trashed'
         AND NULLIF(BTRIM(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'Failure transition requires a reason' USING ERRCODE = '22023';
      END IF;

      UPDATE documents
      SET status = p_to_state,
          -- Trashing a failed document keeps its reason, and restoring it
          -- hands the reason back with the state.
          failure_reason = CASE
            WHEN current_state = 'trashed' THEN failure_reason
            WHEN p_to_state = 'failed' THEN p_reason
            WHEN p_to_state = 'trashed' THEN failure_reason
            ELSE NULL
          END,
          -- A restore into 'processing' resumes an attempt that was already
          -- counted; it must not inflate the retry count.
          processing_attempts = processing_attempts + CASE
            WHEN p_to_state = 'processing' AND current_state <> 'trashed' THEN 1
            ELSE 0
          END,
          pre_trash_status = CASE WHEN p_to_state = 'trashed' THEN current_state ELSE NULL END,
          trashed_at = CASE WHEN p_to_state = 'trashed' THEN CURRENT_TIMESTAMP ELSE NULL END,
          purge_after = CASE
            WHEN p_to_state = 'trashed' THEN CURRENT_TIMESTAMP + INTERVAL '90 days'
            ELSE NULL
          END,
          trashed_by = CASE WHEN p_to_state = 'trashed' THEN trashed_by ELSE NULL END,
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
