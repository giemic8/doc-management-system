import type { Migration } from './index';

/**
 * Ticket #35 -- review inbox, extraction confidence and duplicate detection.
 *
 * Until now the worker wrote whatever the model returned straight onto the
 * document and jumped to 'ready'. A guess and a fact were stored in the same
 * columns, indistinguishable afterwards, and nobody was ever asked. The
 * lifecycle already had a 'review' state (v002) with nothing that could
 * reach it; this migration is what lights it up.
 *
 * Three things get their own storage:
 *
 * - `document_extractions` -- one row per extracted field, with the model's
 *   confidence and the decision the thresholds produced. A proposal is not
 *   the document: it is applied only when it clears `auto_accept_confidence`,
 *   and `applied_value` records what actually landed.
 * - `review_items` -- the inbox itself. A document with an open item is in
 *   'review' and stays there across worker and provider restarts, because
 *   the queue is a table and not something a process holds.
 * - `document_duplicate_links` -- the memory of duplicate decisions. A pair
 *   is a 'candidate' until a human says 'linked' or 'separated'; nothing in
 *   this schema can merge two documents, which is the point.
 *
 * The thresholds live in `review_settings` rather than in code because both
 * the Python worker and the TypeScript backend have to agree on them, and
 * because "configurable" means an administrator changes them without a
 * deployment. `review_decision_for()` is the single place that compares a
 * confidence against them.
 */
export const reviewInbox: Migration = {
  version: 6,
  name: 'review_inbox',
  sql: `
    CREATE TABLE IF NOT EXISTS review_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
      auto_accept_confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.850,
      review_confidence NUMERIC(4, 3) NOT NULL DEFAULT 0.500,
      duplicate_similarity NUMERIC(4, 3) NOT NULL DEFAULT 0.900,
      similarity_scan_candidates INT NOT NULL DEFAULT 200,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT review_settings_is_singleton CHECK (singleton),
      CONSTRAINT review_thresholds_are_probabilities CHECK (
        auto_accept_confidence BETWEEN 0 AND 1
        AND review_confidence BETWEEN 0 AND 1
        AND duplicate_similarity BETWEEN 0 AND 1
      ),
      -- Auto-accepting at a lower bar than the one that merely proposes a
      -- value would make the review inbox unreachable by construction.
      CONSTRAINT review_thresholds_are_ordered CHECK (review_confidence <= auto_accept_confidence),
      CONSTRAINT review_scan_budget_is_positive CHECK (similarity_scan_candidates BETWEEN 1 AND 5000)
    );

    INSERT INTO review_settings (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS document_extractions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      field VARCHAR(50) NOT NULL,
      proposed_value JSONB,
      confidence NUMERIC(4, 3) NOT NULL,
      decision VARCHAR(20) NOT NULL,
      applied_value JSONB,
      provider VARCHAR(50),
      model VARCHAR(100),
      resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT document_extraction_field_is_known CHECK (
        field IN ('doc_type', 'sender', 'recipient', 'document_date', 'due_date', 'amount', 'summary', 'tags')
      ),
      CONSTRAINT document_extraction_confidence_is_probability CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT document_extraction_decision_is_known CHECK (
        decision IN ('auto_accepted', 'needs_review', 'discarded')
      ),
      CONSTRAINT document_extraction_field_is_unique UNIQUE (document_id, field)
    );

    CREATE INDEX IF NOT EXISTS idx_document_extractions_document
      ON document_extractions (document_id);

    CREATE TABLE IF NOT EXISTS review_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      duplicate_of UUID REFERENCES documents(id) ON DELETE CASCADE,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMP WITH TIME ZONE,
      resolution_note TEXT,
      CONSTRAINT review_item_kind_is_known CHECK (
        kind IN ('low_confidence', 'exact_duplicate', 'similar_document')
      ),
      CONSTRAINT review_item_status_is_known CHECK (
        status IN ('open', 'accepted', 'corrected', 'separated', 'retried', 'dismissed')
      ),
      -- A duplicate item without its counterpart is unanswerable, and a
      -- low-confidence item with one is a different question.
      CONSTRAINT review_item_duplicate_has_counterpart CHECK (
        (kind IN ('exact_duplicate', 'similar_document')) = (duplicate_of IS NOT NULL)
      ),
      CONSTRAINT review_item_counterpart_is_another_document CHECK (
        duplicate_of IS NULL OR duplicate_of <> document_id
      ),
      CONSTRAINT review_item_resolution_is_recorded CHECK ((status = 'open') = (resolved_at IS NULL))
    );

    -- One open question per document per subject: re-running extraction
    -- must reuse the open item instead of stacking a second copy of it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_open_low_confidence
      ON review_items (document_id)
      WHERE status = 'open' AND kind = 'low_confidence';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_open_duplicate
      ON review_items (document_id, kind, duplicate_of)
      WHERE status = 'open' AND duplicate_of IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_review_items_open
      ON review_items (created_at)
      WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS document_duplicate_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      duplicate_of UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind VARCHAR(20) NOT NULL,
      similarity NUMERIC(4, 3) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'candidate',
      decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT duplicate_link_kind_is_known CHECK (kind IN ('exact', 'similar')),
      CONSTRAINT duplicate_link_status_is_known CHECK (status IN ('candidate', 'linked', 'separated')),
      CONSTRAINT duplicate_link_similarity_is_probability CHECK (similarity BETWEEN 0 AND 1),
      CONSTRAINT duplicate_link_joins_two_documents CHECK (document_id <> duplicate_of)
    );

    -- The pair is the identity, in either direction: once two documents have
    -- been compared, the answer is remembered and never asked again.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_duplicate_pair
      ON document_duplicate_links (LEAST(document_id, duplicate_of), GREATEST(document_id, duplicate_of));

    CREATE INDEX IF NOT EXISTS idx_document_duplicate_links_counterpart
      ON document_duplicate_links (duplicate_of);

    -- Similarity is compared against stored text, so it can only run once the
    -- worker has produced that text. The column is the resumable marker: a
    -- worker or provider restart leaves the scan pending, not lost.
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS similarity_scanned_at TIMESTAMP WITH TIME ZONE;

    CREATE INDEX IF NOT EXISTS idx_documents_similarity_pending
      ON documents (created_at)
      WHERE similarity_scanned_at IS NULL;

    /**
     * The single comparison of a confidence against the configured
     * thresholds. Both the worker and the backend go through it, so
     * changing a threshold changes every producer at once.
     */
    CREATE OR REPLACE FUNCTION review_decision_for(p_confidence NUMERIC)
    RETURNS VARCHAR AS $$
    DECLARE
      settings review_settings%ROWTYPE;
    BEGIN
      SELECT * INTO settings FROM review_settings WHERE singleton;
      IF p_confidence >= settings.auto_accept_confidence THEN
        RETURN 'auto_accepted';
      ELSIF p_confidence >= settings.review_confidence THEN
        RETURN 'needs_review';
      END IF;
      -- Below the review threshold the guess is too weak to show: putting it
      -- in front of a reviewer as a suggestion would anchor them to it.
      RETURN 'discarded';
    END;
    $$ LANGUAGE plpgsql STABLE;

    CREATE OR REPLACE FUNCTION record_extraction(
      p_document_id UUID,
      p_field VARCHAR,
      p_value JSONB,
      p_confidence NUMERIC,
      p_provider VARCHAR DEFAULT NULL,
      p_model VARCHAR DEFAULT NULL
    ) RETURNS SETOF document_extractions AS $$
    BEGIN
      RETURN QUERY
      INSERT INTO document_extractions (
        document_id, field, proposed_value, confidence, decision, provider, model
      ) VALUES (
        p_document_id, p_field, p_value, p_confidence, review_decision_for(p_confidence), p_provider, p_model
      )
      ON CONFLICT (document_id, field) DO UPDATE SET
        proposed_value = EXCLUDED.proposed_value,
        confidence = EXCLUDED.confidence,
        decision = EXCLUDED.decision,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        -- A fresh extraction supersedes the previous answer, including a
        -- human one: the reviewer is asked again rather than silently
        -- keeping a correction made against different text.
        applied_value = NULL,
        resolved_by = NULL,
        resolved_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    END;
    $$ LANGUAGE plpgsql;

    /**
     * Writes one extracted value onto the document. Returns FALSE when the
     * value cannot be stored in its column -- an unparseable date, a sender
     * longer than the column -- so the caller can route it to a human
     * instead of failing the whole document over one bad field.
     */
    CREATE OR REPLACE FUNCTION apply_extraction_value(
      p_document_id UUID,
      p_field VARCHAR,
      p_value JSONB
    ) RETURNS BOOLEAN AS $$
    DECLARE
      tag_name TEXT;
      applied_any BOOLEAN := FALSE;
    BEGIN
      IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN FALSE;
      END IF;

      IF p_field = 'tags' THEN
        IF jsonb_typeof(p_value) <> 'array' THEN
          RETURN FALSE;
        END IF;
        FOR tag_name IN SELECT jsonb_array_elements_text(p_value) LOOP
          tag_name := BTRIM(tag_name);
          CONTINUE WHEN tag_name = '' OR LENGTH(tag_name) > 100;
          INSERT INTO tags (name) VALUES (tag_name) ON CONFLICT (name) DO NOTHING;
          INSERT INTO document_tags (document_id, tag_id)
          SELECT p_document_id, id FROM tags WHERE name = tag_name
          ON CONFLICT DO NOTHING;
          applied_any := TRUE;
        END LOOP;
        RETURN applied_any;
      END IF;

      BEGIN
        IF p_field IN ('doc_type', 'sender', 'recipient', 'summary') THEN
          EXECUTE format(
            'UPDATE documents SET %I = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;', p_field
          ) USING p_document_id, NULLIF(BTRIM(p_value #>> '{}'), '');
        ELSIF p_field IN ('document_date', 'due_date') THEN
          EXECUTE format(
            'UPDATE documents SET %I = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;', p_field
          ) USING p_document_id, (p_value #>> '{}')::date;
        ELSIF p_field = 'amount' THEN
          EXECUTE format(
            'UPDATE documents SET %I = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1;', p_field
          ) USING p_document_id, (p_value #>> '{}')::numeric;
        ELSE
          RETURN FALSE;
        END IF;
      EXCEPTION
        WHEN invalid_text_representation
          OR invalid_datetime_format
          OR datetime_field_overflow
          OR numeric_value_out_of_range
          OR string_data_right_truncation THEN
          RETURN FALSE;
      END;

      RETURN TRUE;
    END;
    $$ LANGUAGE plpgsql;

    /**
     * Applies every auto-accepted proposal for a document and returns TRUE
     * when something is left for a person. Idempotent: an already applied
     * or already resolved field is not touched again, so re-running after a
     * crash cannot double-apply or re-open a settled question.
     */
    CREATE OR REPLACE FUNCTION apply_document_extractions(p_document_id UUID)
    RETURNS BOOLEAN AS $$
    DECLARE
      extraction document_extractions%ROWTYPE;
      unresolved TEXT[] := ARRAY[]::TEXT[];
      value_applied BOOLEAN;
    BEGIN
      FOR extraction IN
        SELECT * FROM document_extractions WHERE document_id = p_document_id ORDER BY field
      LOOP
        IF extraction.resolved_at IS NOT NULL THEN
          CONTINUE;
        END IF;

        IF extraction.decision = 'auto_accepted' THEN
          IF extraction.applied_value IS NOT NULL THEN
            CONTINUE;
          END IF;
          value_applied := apply_extraction_value(p_document_id, extraction.field, extraction.proposed_value);
          IF value_applied THEN
            UPDATE document_extractions
            SET applied_value = extraction.proposed_value, updated_at = CURRENT_TIMESTAMP
            WHERE id = extraction.id;
            CONTINUE;
          END IF;
          -- Confident but unusable: the model was sure about something the
          -- column cannot hold, which is exactly a reviewer's problem.
          UPDATE document_extractions
          SET decision = 'needs_review', updated_at = CURRENT_TIMESTAMP
          WHERE id = extraction.id;
        END IF;

        unresolved := unresolved || extraction.field;
      END LOOP;

      IF array_length(unresolved, 1) IS NULL THEN
        UPDATE review_items
        SET status = 'accepted',
            resolved_at = CURRENT_TIMESTAMP,
            resolution_note = 'Alle Vorschlaege erreichten die Schwelle fuer automatische Uebernahme'
        WHERE document_id = p_document_id AND kind = 'low_confidence' AND status = 'open';
        RETURN FALSE;
      END IF;

      UPDATE review_items
      SET detail = jsonb_build_object('fields', to_jsonb(unresolved))
      WHERE document_id = p_document_id AND kind = 'low_confidence' AND status = 'open';

      IF NOT FOUND THEN
        INSERT INTO review_items (document_id, kind, detail)
        VALUES (p_document_id, 'low_confidence', jsonb_build_object('fields', to_jsonb(unresolved)));
      END IF;

      RETURN TRUE;
    END;
    $$ LANGUAGE plpgsql;

    /**
     * Decides where a document belongs once its open questions change:
     * 'review' while a person still owes an answer, 'ready' when nobody
     * does. Every producer -- worker, review route, retry -- goes through
     * this, so the inbox and the lifecycle can never disagree.
     */
    CREATE OR REPLACE FUNCTION settle_document_review(p_document_id UUID)
    RETURNS VARCHAR AS $$
    DECLARE
      current_status VARCHAR(50);
      open_items INT;
    BEGIN
      SELECT status INTO current_status FROM documents WHERE id = p_document_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Document % not found', p_document_id USING ERRCODE = 'P0002';
      END IF;

      -- A trashed or still-ingesting document is not the review inbox's
      -- business; the lifecycle owns those states.
      IF current_status NOT IN ('processing', 'review', 'ready') THEN
        RETURN current_status;
      END IF;

      SELECT COUNT(*) INTO open_items
      FROM review_items WHERE document_id = p_document_id AND status = 'open';

      IF open_items > 0 THEN
        IF current_status <> 'review' THEN
          PERFORM transition_document(p_document_id, 'review', NULL);
        END IF;
        RETURN 'review';
      END IF;

      IF current_status <> 'ready' THEN
        PERFORM transition_document(p_document_id, 'ready', NULL);
      END IF;
      RETURN 'ready';
    END;
    $$ LANGUAGE plpgsql;
  `,
};
