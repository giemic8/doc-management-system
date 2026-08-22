import { query } from '../database/db';

/**
 * Ticket #35 -- finding documents the household already has.
 *
 * Two different questions, deliberately answered differently:
 *
 * - **Exact** -- the same bytes arrived twice. The hash proves it, so the
 *   answer is certain and it is recorded at ingest, where the hash is
 *   already in hand and the second original is never written (ingestion
 *   hardlinks into the verified copies instead).
 * - **Similar** -- the same content arrived in a different file: the
 *   invoice re-scanned, the PDF re-exported, the photo of the letter that
 *   was also mailed. That answer is a judgement, so it is only ever a
 *   candidate, and nothing in this module merges, replaces or deletes a
 *   document. A person decides, or the pair stays as it is.
 *
 * Detection never crosses a space boundary. "You already have this file"
 * is information about a space's contents, so telling somebody it about a
 * space they cannot read would walk straight around invariant 10 -- an
 * administrator could learn what is in a private space by uploading a copy
 * of it. Duplicates are found within the document's own space, and the
 * common area is a space like any other for this purpose.
 *
 * The comparison is a plain Jaccard overlap of the OCR token sets, run
 * over a bounded candidate list rather than an index. A household archive
 * is thousands of documents, not millions; an exact score anyone can
 * recompute by hand beats an approximate one nobody can argue with.
 */

/** Below this a document has too little text for an overlap to mean anything. */
const MINIMUM_TOKENS = 20;

/** Tokens shorter than this are noise once OCR has had its way with them. */
const MINIMUM_TOKEN_LENGTH = 3;

export interface SimilarityScanResult {
  scanned: boolean;
  skippedReason?: 'document_missing' | 'not_comparable' | 'too_little_text';
  candidates: number;
  matches: Array<{ documentId: string; similarity: number }>;
}

export function tokenize(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^0-9a-zäöüß]+/g, ' ')
      .split(' ')
      .filter((token) => token.length >= MINIMUM_TOKEN_LENGTH)
  );
}

/** |A ∩ B| / |A ∪ B|. Two empty documents are not "identical", they are unknown. */
export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Rounds to what the NUMERIC(4,3) columns can actually store. */
function asStoredScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

/**
 * Records a duplicate pair and the question it raises. Returns false when
 * the pair is already known -- including when a reviewer has already said
 * "these are different", which is why a separated pair never comes back.
 */
async function recordDuplicatePair(
  documentId: string,
  counterpartId: string,
  kind: 'exact' | 'similar',
  similarity: number
): Promise<boolean> {
  const inserted = await query(
    `INSERT INTO document_duplicate_links (document_id, duplicate_of, kind, similarity)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM document_duplicate_links existing
       WHERE LEAST(existing.document_id, existing.duplicate_of) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(existing.document_id, existing.duplicate_of) = GREATEST($1::uuid, $2::uuid)
     )
     RETURNING id;`,
    [documentId, counterpartId, kind, asStoredScore(similarity)]
  );

  if (inserted.rows.length === 0) {
    return false;
  }

  await query(
    `INSERT INTO review_items (document_id, kind, duplicate_of, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT DO NOTHING;`,
    [
      documentId,
      kind === 'exact' ? 'exact_duplicate' : 'similar_document',
      counterpartId,
      JSON.stringify({ similarity: asStoredScore(similarity) }),
    ]
  );

  return true;
}

/**
 * Called from ingestion, where the hash has just been computed. Best-effort
 * by contract: a duplicate is a remark about a document, never a reason to
 * fail the delivery that carried it.
 */
export async function recordExactDuplicate(
  documentId: string,
  fileHash: string
): Promise<string | null> {
  try {
    const counterpart = await query(
      `SELECT other.id
       FROM documents other
       JOIN documents subject ON subject.id = $2
       WHERE other.file_hash = $1
         AND other.id <> subject.id
         AND other.status <> 'trashed'
         AND other.space_id IS NOT DISTINCT FROM subject.space_id
       ORDER BY other.created_at ASC
       LIMIT 1;`,
      [fileHash, documentId]
    );

    const counterpartId = counterpart.rows[0]?.id as string | undefined;
    if (!counterpartId) return null;

    await recordDuplicatePair(documentId, counterpartId, 'exact', 1);
    return counterpartId;
  } catch (error: any) {
    console.error(`Duplicate detection failed for document ${documentId}: ${error.message}`);
    return null;
  }
}

/**
 * Compares one document against the recent archive. The `similarity_scanned_at`
 * marker is set even when nothing matches, and only after the comparison
 * finished, so a worker or provider restart mid-scan leaves the document
 * pending rather than silently unexamined.
 */
export async function scanDocumentForSimilarity(documentId: string): Promise<SimilarityScanResult> {
  const subject = await query(
    `SELECT d.id, d.title, d.ocr_text, d.status, d.file_hash, d.space_id,
            s.duplicate_similarity, s.similarity_scan_candidates
     FROM documents d CROSS JOIN review_settings s
     WHERE d.id = $1 AND s.singleton;`,
    [documentId]
  );

  const document = subject.rows[0];
  if (!document) {
    return { scanned: false, skippedReason: 'document_missing', candidates: 0, matches: [] };
  }

  const markScanned = async () => {
    await query('UPDATE documents SET similarity_scanned_at = CURRENT_TIMESTAMP WHERE id = $1;', [documentId]);
  };

  if (document.status === 'trashed') {
    // Nothing about a deleted document is a question for a reviewer.
    await markScanned();
    return { scanned: true, skippedReason: 'not_comparable', candidates: 0, matches: [] };
  }

  const subjectTokens = tokenize(`${document.title ?? ''} ${document.ocr_text ?? ''}`);
  if (subjectTokens.size < MINIMUM_TOKENS) {
    await markScanned();
    return { scanned: true, skippedReason: 'too_little_text', candidates: 0, matches: [] };
  }

  const threshold = Number(document.duplicate_similarity);
  const budget = Number(document.similarity_scan_candidates);

  const candidates = await query(
    `SELECT d.id, d.title, d.ocr_text
     FROM documents d
     WHERE d.id <> $1
       AND d.status <> 'trashed'
       AND d.ocr_text IS NOT NULL
       AND d.space_id IS NOT DISTINCT FROM $3::uuid
       AND NOT EXISTS (
         SELECT 1 FROM document_duplicate_links existing
         WHERE LEAST(existing.document_id, existing.duplicate_of) = LEAST(d.id, $1::uuid)
           AND GREATEST(existing.document_id, existing.duplicate_of) = GREATEST(d.id, $1::uuid)
       )
     ORDER BY d.created_at DESC
     LIMIT $2;`,
    [documentId, budget, document.space_id]
  );

  const matches: Array<{ documentId: string; similarity: number }> = [];
  for (const candidate of candidates.rows) {
    const score = jaccardSimilarity(subjectTokens, tokenize(`${candidate.title ?? ''} ${candidate.ocr_text ?? ''}`));
    if (score < threshold) continue;
    await recordDuplicatePair(documentId, candidate.id, 'similar', score);
    matches.push({ documentId: candidate.id, similarity: asStoredScore(score) });
  }

  await markScanned();

  if (matches.length > 0) {
    // A found candidate is an open question, so the document belongs in the
    // inbox even if every extracted field was confident.
    await query('SELECT settle_document_review($1);', [documentId]);
  }

  return { scanned: true, candidates: candidates.rows.length, matches };
}

/**
 * Sweeps documents whose text exists but has never been compared. Runs from
 * the scheduler, and is safe to run repeatedly: the marker is the queue.
 */
export async function scanPendingSimilarities(limit = 20): Promise<SimilarityScanResult[]> {
  const pending = await query(
    `SELECT id FROM documents
     WHERE similarity_scanned_at IS NULL
       AND status IN ('review', 'ready')
       AND ocr_text IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $1;`,
    [limit]
  );

  const results: SimilarityScanResult[] = [];
  for (const row of pending.rows) {
    try {
      results.push(await scanDocumentForSimilarity(row.id));
    } catch (error: any) {
      // One unreadable document must not stop the sweep for the rest.
      console.error(`Similarity scan failed for document ${row.id}: ${error.message}`);
    }
  }
  return results;
}
