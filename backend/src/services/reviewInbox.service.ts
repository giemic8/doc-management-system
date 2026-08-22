import { pool, query } from '../database/db';
import { AclContext, buildDocumentAclWhereClause, canUserModifyDocument, logUnauthorizedAccess } from './acl.service';

/**
 * Ticket #35 -- the review inbox.
 *
 * Extraction used to write whatever the model returned straight onto the
 * document. A guess and a fact ended up in the same columns and nobody was
 * ever asked. Now a proposal is stored with its confidence, only what
 * clears the configured bar is applied, and everything else becomes an
 * open item here: a question with an owner, a document, and four possible
 * answers -- accept it, correct it, ask for another try, or say the two
 * documents are not the same thing.
 *
 * The queue is a table, not something a process holds, so a worker or
 * provider restart changes nothing about what is still owed.
 */

export type ReviewItemKind = 'low_confidence' | 'exact_duplicate' | 'similar_document';
export type ReviewItemStatus = 'open' | 'accepted' | 'corrected' | 'separated' | 'retried' | 'dismissed';
export type ReviewAction = 'accept' | 'correct' | 'retry' | 'separate' | 'dismiss';

/** The fields an extraction may speak about; also the fields a reviewer may correct. */
export const REVIEWABLE_FIELDS = [
  'doc_type',
  'sender',
  'recipient',
  'document_date',
  'due_date',
  'amount',
  'summary',
  'tags',
] as const;

export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

export interface ReviewActor {
  id: string;
  role: string;
  ip?: string;
}

export class ReviewError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewSettings {
  autoAcceptConfidence: number;
  reviewConfidence: number;
  duplicateSimilarity: number;
  similarityScanCandidates: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ReviewProposal {
  field: ReviewableField;
  proposedValue: unknown;
  appliedValue: unknown;
  confidence: number;
  decision: 'auto_accepted' | 'needs_review' | 'discarded';
  provider: string | null;
  model: string | null;
  resolvedAt: string | null;
}

export interface ReviewItemView {
  id: string;
  documentId: string;
  documentTitle: string;
  documentStatus: string;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  detail: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  counterpart: {
    documentId: string;
    title: string | null;
    redacted: boolean;
    similarity: number | null;
    linkStatus: string | null;
  } | null;
  proposals: ReviewProposal[];
}

export interface ReviewResolution {
  item: ReviewItemView;
  documentStatus: string;
  appliedFields: string[];
  rejectedFields: string[];
}

function settingsFrom(row: any): ReviewSettings {
  return {
    autoAcceptConfidence: Number(row.auto_accept_confidence),
    reviewConfidence: Number(row.review_confidence),
    duplicateSimilarity: Number(row.duplicate_similarity),
    similarityScanCandidates: Number(row.similarity_scan_candidates),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  const result = await query('SELECT * FROM review_settings WHERE singleton;');
  if (result.rows.length === 0) {
    throw new ReviewError(500, 'settings_missing', 'Review settings row is missing');
  }
  return settingsFrom(result.rows[0]);
}

function probability(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ReviewError(400, 'invalid_threshold', `${field} must be a number between 0 and 1`, { field });
  }
  return parsed;
}

export interface ReviewSettingsPatch {
  autoAcceptConfidence?: unknown;
  reviewConfidence?: unknown;
  duplicateSimilarity?: unknown;
  similarityScanCandidates?: unknown;
}

/**
 * Thresholds are configuration, not code: an administrator moves them
 * without a deployment, and every producer -- worker included -- sees the
 * change at once because the comparison itself lives in the database.
 */
export async function updateReviewSettings(
  actor: ReviewActor,
  patch: ReviewSettingsPatch
): Promise<ReviewSettings> {
  if (actor.role !== 'admin') {
    throw new ReviewError(403, 'admin_only', 'Only an administrator changes the review thresholds');
  }

  const current = await getReviewSettings();
  const next: ReviewSettings = {
    ...current,
    autoAcceptConfidence:
      patch.autoAcceptConfidence === undefined
        ? current.autoAcceptConfidence
        : probability(patch.autoAcceptConfidence, 'autoAcceptConfidence'),
    reviewConfidence:
      patch.reviewConfidence === undefined
        ? current.reviewConfidence
        : probability(patch.reviewConfidence, 'reviewConfidence'),
    duplicateSimilarity:
      patch.duplicateSimilarity === undefined
        ? current.duplicateSimilarity
        : probability(patch.duplicateSimilarity, 'duplicateSimilarity'),
  };

  if (patch.similarityScanCandidates !== undefined) {
    const budget = Number(patch.similarityScanCandidates);
    if (!Number.isInteger(budget) || budget < 1 || budget > 5000) {
      throw new ReviewError(400, 'invalid_threshold', 'similarityScanCandidates must be between 1 and 5000', {
        field: 'similarityScanCandidates',
      });
    }
    next.similarityScanCandidates = budget;
  }

  if (next.reviewConfidence > next.autoAcceptConfidence) {
    // Auto-accepting at a lower bar than the one that merely proposes a
    // value would make the inbox unreachable by construction.
    throw new ReviewError(
      400,
      'thresholds_out_of_order',
      'reviewConfidence must not exceed autoAcceptConfidence',
      { autoAcceptConfidence: next.autoAcceptConfidence, reviewConfidence: next.reviewConfidence }
    );
  }

  const updated = await query(
    `UPDATE review_settings
     SET auto_accept_confidence = $1,
         review_confidence = $2,
         duplicate_similarity = $3,
         similarity_scan_candidates = $4,
         updated_by = $5,
         updated_at = CURRENT_TIMESTAMP
     WHERE singleton
     RETURNING *;`,
    [
      next.autoAcceptConfidence,
      next.reviewConfidence,
      next.duplicateSimilarity,
      next.similarityScanCandidates,
      actor.id,
    ]
  );

  await query(
    `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4);`,
    [
      actor.id,
      'review_settings_changed',
      JSON.stringify({ from: current, to: next }),
      actor.ip ?? null,
    ]
  );

  return settingsFrom(updated.rows[0]);
}

function proposalFrom(row: any): ReviewProposal {
  return {
    field: row.field,
    proposedValue: row.proposed_value ?? null,
    appliedValue: row.applied_value ?? null,
    confidence: Number(row.confidence),
    decision: row.decision,
    provider: row.provider ?? null,
    model: row.model ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}

function itemFrom(row: any, proposals: ReviewProposal[]): ReviewItemView {
  const redacted = row.counterpart_redacted === true;
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentStatus: row.document_status,
    kind: row.kind,
    status: row.status,
    detail: row.detail ?? {},
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    resolutionNote: row.resolution_note ?? null,
    counterpart: row.duplicate_of
      ? {
          documentId: row.duplicate_of,
          // Same trade as the audit log: the reviewer is told a counterpart
          // exists, because that is the question, but a title they may not
          // read stays out of it.
          title: redacted ? null : row.counterpart_title ?? null,
          redacted,
          similarity: row.similarity === null || row.similarity === undefined ? null : Number(row.similarity),
          linkStatus: row.link_status ?? null,
        }
      : null,
    proposals,
  };
}

const ITEM_SELECT = `
  SELECT ri.id, ri.document_id, ri.kind, ri.status, ri.detail, ri.created_at,
         ri.resolved_at, ri.resolution_note, ri.duplicate_of,
         d.title AS document_title, d.status AS document_status,
         counterpart.title AS counterpart_title,
         link.similarity, link.status AS link_status
  FROM review_items ri
  JOIN documents d ON d.id = ri.document_id
  LEFT JOIN documents counterpart ON counterpart.id = ri.duplicate_of
  LEFT JOIN document_duplicate_links link
    ON LEAST(link.document_id, link.duplicate_of) = LEAST(ri.document_id, ri.duplicate_of)
   AND GREATEST(link.document_id, link.duplicate_of) = GREATEST(ri.document_id, ri.duplicate_of)
`;

async function proposalsFor(documentIds: string[]): Promise<Map<string, ReviewProposal[]>> {
  const byDocument = new Map<string, ReviewProposal[]>();
  if (documentIds.length === 0) return byDocument;

  const rows = await query(
    `SELECT * FROM document_extractions WHERE document_id = ANY($1::uuid[]) ORDER BY field;`,
    [documentIds]
  );

  for (const row of rows.rows) {
    const list = byDocument.get(row.document_id) ?? [];
    list.push(proposalFrom(row));
    byDocument.set(row.document_id, list);
  }
  return byDocument;
}

/** Whether one document passes the caller's full read rule. */
async function isReadableBy(actor: ReviewActor, documentId: string | null): Promise<boolean> {
  if (!documentId) return false;
  const params: any[] = [documentId];
  const clause = buildDocumentAclWhereClause({ userId: actor.id, role: actor.role }, params);
  const result = await query(`SELECT 1 FROM documents d WHERE d.id = $1 AND (${clause}) LIMIT 1;`, params);
  return result.rows.length > 0;
}

export interface ListReviewOptions {
  status?: 'open' | 'all';
  limit?: number;
}

export async function listReviewItems(
  actor: ReviewActor,
  options: ListReviewOptions = {}
): Promise<ReviewItemView[]> {
  const ctx: AclContext = { userId: actor.id, role: actor.role };
  const params: any[] = [];
  const aclClause = buildDocumentAclWhereClause(ctx, params);
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  params.push(limit);

  const rows = await query(
    `${ITEM_SELECT}
     WHERE ${options.status === 'all' ? 'TRUE' : "ri.status = 'open'"}
       AND (${aclClause})
     ORDER BY ri.created_at ASC
     LIMIT $${params.length};`,
    params
  );

  // The counterpart gets its own evaluation of the rule: the inbox must not
  // become a way to learn the titles of documents the reviewer cannot read.
  const counterpartIds = [...new Set(rows.rows.map((row: any) => row.duplicate_of).filter(Boolean))];
  const readable = new Set<string>();
  if (counterpartIds.length > 0) {
    const counterpartParams: any[] = [counterpartIds];
    const counterpartClause = buildDocumentAclWhereClause(ctx, counterpartParams);
    const visible = await query(
      `SELECT d.id FROM documents d WHERE d.id = ANY($1::uuid[]) AND (${counterpartClause});`,
      counterpartParams
    );
    for (const row of visible.rows) readable.add(row.id);
  }

  const proposals = await proposalsFor([...new Set(rows.rows.map((row: any) => row.document_id))]);

  return rows.rows.map((row: any) =>
    itemFrom(
      { ...row, counterpart_redacted: Boolean(row.duplicate_of) && !readable.has(row.duplicate_of) },
      proposals.get(row.document_id) ?? []
    )
  );
}

export async function countOpenReviewItems(actor: ReviewActor): Promise<number> {
  const ctx: AclContext = { userId: actor.id, role: actor.role };
  const params: any[] = [];
  const aclClause = buildDocumentAclWhereClause(ctx, params);
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM review_items ri
     JOIN documents d ON d.id = ri.document_id
     WHERE ri.status = 'open' AND (${aclClause});`,
    params
  );
  return result.rows[0]?.count ?? 0;
}

async function loadOpenItem(itemId: string) {
  const result = await query(
    `SELECT ri.*, d.status AS document_status, d.title AS document_title
     FROM review_items ri
     JOIN documents d ON d.id = ri.document_id
     WHERE ri.id = $1;`,
    [itemId]
  );
  return result.rows[0];
}

async function assertReviewer(actor: ReviewActor, item: any): Promise<void> {
  const ctx: AclContext = { userId: actor.id, role: actor.role };
  // Reviewing writes metadata onto the document, so it needs the write half
  // of the rule -- reading the inbox is not the same as answering it.
  if (!(await canUserModifyDocument(ctx, item.document_id))) {
    await logUnauthorizedAccess(actor.id, item.document_id, 'review_resolve', { ip: actor.ip });
    throw new ReviewError(403, 'forbidden', 'You do not have write permission for this document');
  }
  if (item.document_status === 'trashed') {
    throw new ReviewError(409, 'document_trashed', 'Document is in the trash; restore it before reviewing it');
  }
}

function assertDuplicateItem(item: any, action: ReviewAction): void {
  if (item.kind === 'low_confidence') {
    throw new ReviewError(400, 'action_not_applicable', `'${action}' answers a duplicate candidate, not a field`, {
      kind: item.kind,
    });
  }
}

async function closeItem(
  itemId: string,
  status: Exclude<ReviewItemStatus, 'open'>,
  actor: ReviewActor,
  note: string | null
): Promise<void> {
  await query(
    `UPDATE review_items
     SET status = $2, resolved_by = $3, resolved_at = CURRENT_TIMESTAMP, resolution_note = $4
     WHERE id = $1;`,
    [itemId, status, actor.id, note]
  );
}

async function decideDuplicateLink(
  item: any,
  status: 'linked' | 'separated',
  actor: ReviewActor
): Promise<void> {
  await query(
    `UPDATE document_duplicate_links
     SET status = $3, decided_by = $4, decided_at = CURRENT_TIMESTAMP
     WHERE LEAST(document_id, duplicate_of) = LEAST($1::uuid, $2::uuid)
       AND GREATEST(document_id, duplicate_of) = GREATEST($1::uuid, $2::uuid);`,
    [item.document_id, item.duplicate_of, status, actor.id]
  );
}

/** Applies one value and says whether the column could actually take it. */
async function applyValue(
  client: any,
  documentId: string,
  field: string,
  value: unknown
): Promise<boolean> {
  const applied = await client.query('SELECT apply_extraction_value($1, $2, $3::jsonb) AS applied;', [
    documentId,
    field,
    JSON.stringify(value ?? null),
  ]);
  return applied.rows[0]?.applied === true;
}

async function acceptProposals(
  item: any,
  actor: ReviewActor
): Promise<{ appliedFields: string[]; rejectedFields: string[] }> {
  const appliedFields: string[] = [];
  const rejectedFields: string[] = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT * FROM document_extractions
       WHERE document_id = $1 AND resolved_at IS NULL
       ORDER BY field;`,
      [item.document_id]
    );

    for (const row of pending.rows) {
      let applied = false;
      if (row.decision === 'needs_review') {
        applied = await applyValue(client, item.document_id, row.field, row.proposed_value);
        (applied ? appliedFields : rejectedFields).push(row.field);
      }
      await client.query(
        `UPDATE document_extractions
         SET applied_value = CASE WHEN $2 THEN proposed_value ELSE applied_value END,
             resolved_by = $3,
             resolved_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1;`,
        [row.id, applied, actor.id]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { appliedFields, rejectedFields };
}

async function correctProposals(
  item: any,
  actor: ReviewActor,
  values: Record<string, unknown>
): Promise<{ appliedFields: string[]; rejectedFields: string[] }> {
  const fields = Object.keys(values);
  if (fields.length === 0) {
    throw new ReviewError(400, 'no_values', 'A correction needs at least one field');
  }

  const unknownField = fields.find((field) => !(REVIEWABLE_FIELDS as readonly string[]).includes(field));
  if (unknownField) {
    throw new ReviewError(400, 'unknown_field', `'${unknownField}' is not a reviewable field`, {
      field: unknownField,
      allowed: REVIEWABLE_FIELDS,
    });
  }

  const appliedFields: string[] = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const field of fields) {
      const applied = await applyValue(client, item.document_id, field, values[field]);
      if (!applied) {
        // A correction the column cannot take is the reviewer's mistake, and
        // they are told which field rather than finding half of their answer
        // stored: the whole correction rolls back.
        throw new ReviewError(400, 'invalid_value', `'${field}' could not be stored as given`, { field });
      }
      // A person's answer is not a guess: it is recorded at full confidence
      // so a later reader can see who decided this and when.
      await client.query(
        `SELECT * FROM record_extraction($1, $2, $3::jsonb, 1.0, 'human', NULL);`,
        [item.document_id, field, JSON.stringify(values[field] ?? null)]
      );
      await client.query(
        `UPDATE document_extractions
         SET applied_value = proposed_value, resolved_by = $3, resolved_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE document_id = $1 AND field = $2;`,
        [item.document_id, field, actor.id]
      );
      appliedFields.push(field);
    }

    // Whatever the reviewer did not name, they decided to leave alone.
    await client.query(
      `UPDATE document_extractions
       SET resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE document_id = $1 AND resolved_at IS NULL;`,
      [item.document_id, actor.id]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { appliedFields, rejectedFields: [] };
}

export interface ResolveReviewPayload {
  values?: Record<string, unknown>;
  note?: string;
}

export async function resolveReviewItem(
  actor: ReviewActor,
  itemId: string,
  action: ReviewAction,
  payload: ResolveReviewPayload = {}
): Promise<ReviewResolution> {
  const item = await loadOpenItem(itemId);
  if (!item) {
    throw new ReviewError(404, 'not_found', 'Review item not found');
  }
  if (item.status !== 'open') {
    throw new ReviewError(409, 'already_resolved', 'This review item has already been answered', {
      status: item.status,
    });
  }

  await assertReviewer(actor, item);

  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim().slice(0, 2000) : null;
  let appliedFields: string[] = [];
  let rejectedFields: string[] = [];
  let settle = true;

  switch (action) {
    case 'accept': {
      if (item.kind === 'low_confidence') {
        ({ appliedFields, rejectedFields } = await acceptProposals(item, actor));
      } else {
        // Confirming a duplicate links the pair and stops there. Merging or
        // deleting one of two documents on a similarity score is exactly the
        // irreversible step this feature refuses to take for you.
        await decideDuplicateLink(item, 'linked', actor);
      }
      await closeItem(itemId, 'accepted', actor, note);
      break;
    }
    case 'correct': {
      if (item.kind !== 'low_confidence') {
        throw new ReviewError(400, 'action_not_applicable', "'correct' answers extracted fields, not a duplicate", {
          kind: item.kind,
        });
      }
      ({ appliedFields, rejectedFields } = await correctProposals(item, actor, payload.values ?? {}));
      await closeItem(itemId, 'corrected', actor, note);
      break;
    }
    case 'separate': {
      assertDuplicateItem(item, action);
      await decideDuplicateLink(item, 'separated', actor);
      await closeItem(itemId, 'separated', actor, note);
      break;
    }
    case 'dismiss': {
      await closeItem(itemId, 'dismissed', actor, note);
      break;
    }
    case 'retry': {
      await closeItem(itemId, 'retried', actor, note);
      // New text may mean new neighbours, so the similarity answer is owed
      // again as well.
      await query('UPDATE documents SET similarity_scanned_at = NULL WHERE id = $1;', [item.document_id]);
      if (item.document_status !== 'processing') {
        await query('SELECT * FROM transition_document($1, $2, NULL);', [item.document_id, 'processing']);
      }
      // The document is deliberately left in 'processing': settling it now
      // would declare it ready before the retry it was just asked for.
      settle = false;
      break;
    }
    default:
      throw new ReviewError(400, 'unknown_action', `'${action}' is not a review action`);
  }

  if (settle) {
    await query('SELECT settle_document_review($1);', [item.document_id]);
  }

  await query(
    `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address)
     VALUES ($1, $2, $3, $4, $5);`,
    [
      item.document_id,
      actor.id,
      'review_item_resolved',
      JSON.stringify({
        reviewItemId: itemId,
        kind: item.kind,
        action,
        appliedFields,
        rejectedFields,
        duplicateOf: item.duplicate_of ?? null,
      }),
      actor.ip ?? null,
    ]
  );

  const refreshed = await query(
    `${ITEM_SELECT} WHERE ri.id = $1;`,
    [itemId]
  );
  const documentStatus = await query('SELECT status FROM documents WHERE id = $1;', [item.document_id]);
  const proposals = await proposalsFor([item.document_id]);

  // The answer comes back with the same redaction the listing applies:
  // answering a question about your own document is not a reason to be told
  // the title of the one it was compared against.
  const counterpartReadable = await isReadableBy(actor, item.duplicate_of ?? null);

  return {
    item: itemFrom(
      { ...refreshed.rows[0], counterpart_redacted: Boolean(item.duplicate_of) && !counterpartReadable },
      proposals.get(item.document_id) ?? []
    ),
    documentStatus: documentStatus.rows[0]?.status,
    appliedFields,
    rejectedFields,
  };
}
