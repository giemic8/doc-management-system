import fs from 'fs';
import { pool, query } from '../database/db';
import { config } from '../config';
import { isRetentionLocked } from './retention.service';
import { parseBackupStatusFile, BackupStatus } from './backupStatus.service';
import { dispatchWebhookEvent } from './webhookDispatch.service';
import { buildSpaceVisibilityWhereClause, isPrivateSpace } from './spaceVisibility.service';

/**
 * Ticket #33 -- 90-day trash and controlled purge.
 *
 * Deletion is now two separate, differently authorized actions:
 *
 * - **Trash** is the normal, reversible delete. It moves the document into
 *   the `trashed` lifecycle state, records who did it and when the 90-day
 *   recovery window ends, and touches no bytes on disk. Anyone with delete
 *   permission on the document may do it.
 * - **Purge** is the irreversible one: it destroys both durable original
 *   copies, every derived file and version, and the database row. It is
 *   admin-only, requires an explicit typed confirmation at the route layer,
 *   and is refused while any of the five guards below still applies.
 *
 * Purge guards (the ticket's "honors legal hold, retention, share state,
 * versions, and backup policy"):
 *
 * 1. legal hold -> refused, no override;
 * 2. retention lock -> refused, no override;
 * 3. active share links -> refused unless the caller explicitly asks for
 *    them to be revoked as part of the purge;
 * 4. versions -> every `document_versions` file is destroyed with the
 *    document and counted in the audit event, so a purge never leaves
 *    recoverable copies of "deleted" content behind;
 * 5. backup policy -> refused while the backup system has no successful
 *    run, unless an admin explicitly acknowledges it. Destroying the last
 *    copies of a document while backups are broken removes the only path
 *    back from a mistaken purge.
 *
 * The purge audit event is written before the row disappears and repeats
 * the document id, title, hash and file paths in its details, because
 * `audit_logs.document_id` is set to NULL by the foreign key once the
 * document is gone.
 */

/** Recovery window for trashed documents. Materialized as `purge_after` by migration v004. */
export const TRASH_RETENTION_DAYS = 90;

export interface TrashActor {
  id?: string;
  ip?: string;
  /** Ticket #34 -- needed by the bulk sweep to apply the space rule. */
  role?: string;
}

export type TrashErrorReason =
  | 'not_found'
  | 'not_trashed'
  | 'retention_locked'
  | 'active_share_links'
  | 'backup_unavailable'
  | 'space_forbidden';

/** Carries the HTTP shape of a refused trash/purge so routes stay thin. */
export class TrashError extends Error {
  public readonly status: number;
  public readonly reason: TrashErrorReason;
  public readonly details: Record<string, unknown>;

  constructor(status: number, reason: TrashErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TrashError';
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

export interface PurgeOptions {
  revokeShareLinks?: boolean;
  acknowledgeBackupPolicy?: boolean;
  /** Injectable for tests; defaults to the backup container's status file. */
  backupStatus?: BackupStatus;
}

export interface PurgeResult {
  documentId: string;
  title: string;
  removedFiles: number;
  failedFiles: string[];
  revokedShareLinks: number;
  versionsRemoved: number;
}

export interface TrashListEntry {
  days_remaining: number;
  purge_eligible: boolean;
  retention_locked: boolean;
  active_share_links: number;
  [key: string]: unknown;
}

async function loadDocument(documentId: string) {
  const result = await query('SELECT * FROM documents WHERE id = $1;', [documentId]);
  const document = result.rows[0];
  if (!document) {
    throw new TrashError(404, 'not_found', 'Document not found');
  }
  return document;
}

async function countActiveShareLinks(documentId: string): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM document_share_links
     WHERE document_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);`,
    [documentId]
  );
  return result.rows[0]?.count ?? 0;
}

async function writeAuditEvent(
  documentId: string | null,
  actor: TrashActor,
  action: string,
  details: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5);`,
    [documentId, actor.id ?? null, action, JSON.stringify(details), actor.ip ?? null]
  );
}

/**
 * Days left in the recovery window. Negative once the window elapsed --
 * the document stays restorable until someone actually purges it, so the
 * caller can show "overdue" rather than pretending it is already gone.
 */
export function daysRemaining(purgeAfter: Date | string | null): number {
  if (!purgeAfter) return TRASH_RETENTION_DAYS;
  const millis = new Date(purgeAfter).getTime() - Date.now();
  return Math.ceil(millis / (24 * 60 * 60 * 1000));
}

/** Adds the derived trash fields the API exposes on top of a document row. */
export function describeTrashedDocument(row: any, activeShareLinks: number): TrashListEntry {
  return {
    ...row,
    days_remaining: daysRemaining(row.purge_after),
    purge_eligible: row.purge_after ? new Date(row.purge_after).getTime() <= Date.now() : false,
    retention_locked: isRetentionLocked(row),
    active_share_links: activeShareLinks,
  };
}

/**
 * Normal delete: moves a document into the trash. Retention locks and
 * legal holds block it, matching every other destructive path. Trashing an
 * already-trashed document is a no-op so repeated clicks stay harmless.
 */
export async function trashDocument(documentId: string, actor: TrashActor) {
  const document = await loadDocument(documentId);

  if (document.status === 'trashed') {
    return document;
  }
  if (isRetentionLocked(document)) {
    throw new TrashError(
      423,
      'retention_locked',
      'Document is locked by a retention policy or legal hold and cannot be deleted'
    );
  }

  const client = await pool.connect();
  let trashed;
  try {
    await client.query('BEGIN');
    const transitioned = await client.query('SELECT * FROM transition_document($1::uuid, $2::varchar, NULL);', [
      documentId,
      'trashed',
    ]);
    // The actor is not part of the state machine's signature, so it is set
    // in the same transaction as the transition rather than after it.
    const withActor = await client.query(
      'UPDATE documents SET trashed_by = $2 WHERE id = $1 RETURNING *;',
      [documentId, actor.id ?? null]
    );
    await client.query('COMMIT');
    trashed = withActor.rows[0] ?? transitioned.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await writeAuditEvent(documentId, actor, 'trash', {
    title: document.title,
    previousStatus: document.status,
    purgeAfter: trashed.purge_after,
    retentionDays: TRASH_RETENTION_DAYS,
  });

  // `document.deleted` is the event subscribers already register for; the
  // trash is what deletion means now, so this is where it fires. Ticket #34
  // holds it back for private spaces: webhook endpoints are configured by
  // the administrator, and the title is content.
  isPrivateSpace(trashed.space_id)
    .then((isPrivate) => {
      if (isPrivate) return;
      return dispatchWebhookEvent('document.deleted', {
        id: trashed.id,
        title: trashed.title,
        status: trashed.status,
        purgeAfter: trashed.purge_after,
      });
    })
    .catch((err) => console.error('Webhook dispatch failed for document.deleted:', err));

  return trashed;
}

/**
 * Restores a trashed document into the exact state it held before, as
 * recorded in `pre_trash_status`. Restoring after the 90-day window has
 * elapsed is still allowed: the content demonstrably still exists, and
 * refusing to hand it back would destroy value the purge step has not
 * decided to destroy yet.
 */
export async function restoreDocument(documentId: string, actor: TrashActor) {
  const document = await loadDocument(documentId);

  if (document.status !== 'trashed') {
    throw new TrashError(409, 'not_trashed', 'Document is not in the trash');
  }

  const restoreTo = document.pre_trash_status ?? 'ready';
  const result = await query('SELECT * FROM transition_document($1::uuid, $2::varchar, NULL);', [
    documentId,
    restoreTo,
  ]);
  const restored = result.rows[0];

  await writeAuditEvent(documentId, actor, 'restore', {
    title: document.title,
    restoredTo: restoreTo,
    trashedAt: document.trashed_at,
    overdue: daysRemaining(document.purge_after) < 0,
  });

  return restored;
}

function collectFilePaths(document: any, versionPaths: string[]): string[] {
  return [
    document.file_path,
    document.replica_file_path,
    document.derived_file_path,
    document.thumbnail_path,
    ...versionPaths,
  ].filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0);
}

/**
 * Irreversible destruction of a trashed document: both durable copies,
 * derived files, thumbnails, every stored version, and the row itself.
 * Callers must have established explicit authorization first (admin role
 * plus typed confirmation at the route layer).
 */
export async function purgeDocument(
  documentId: string,
  actor: TrashActor,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const document = await loadDocument(documentId);

  if (document.status !== 'trashed') {
    throw new TrashError(409, 'not_trashed', 'Only documents in the trash can be purged');
  }
  if (isRetentionLocked(document)) {
    throw new TrashError(
      423,
      'retention_locked',
      'Document is locked by a retention policy or legal hold and cannot be purged'
    );
  }

  const activeShareLinks = await countActiveShareLinks(documentId);
  if (activeShareLinks > 0 && !options.revokeShareLinks) {
    throw new TrashError(
      409,
      'active_share_links',
      'Document still has active share links; revoke them or purge with revokeShareLinks',
      { activeShareLinks }
    );
  }

  const backupStatus = options.backupStatus ?? parseBackupStatusFile(config.backupStatusPath);
  if (!backupStatus.success && !options.acknowledgeBackupPolicy) {
    throw new TrashError(
      409,
      'backup_unavailable',
      'No successful backup is on record; purging now removes the last recoverable copies. ' +
        'Repeat with acknowledgeBackupPolicy to override.',
      { backupError: backupStatus.error ?? backupStatus.dashboardAlert.message ?? null }
    );
  }

  const versionsRes = await query('SELECT file_path FROM document_versions WHERE document_id = $1;', [documentId]);
  const versionPaths: string[] = versionsRes.rows.map((row: any) => row.file_path).filter(Boolean);
  const filePaths = collectFilePaths(document, versionPaths);

  let revokedShareLinks = 0;
  if (activeShareLinks > 0) {
    const revoked = await query(
      `UPDATE document_share_links
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE document_id = $1 AND revoked_at IS NULL
       RETURNING id;`,
      [documentId]
    );
    revokedShareLinks = revoked.rows.length;
  }

  // Written while the document still exists so the event carries its id;
  // the details repeat everything an operator would need afterwards,
  // because the foreign key nulls document_id on delete.
  await writeAuditEvent(documentId, actor, 'purge', {
    documentId,
    title: document.title,
    fileHash: document.file_hash,
    trashedAt: document.trashed_at,
    purgeAfter: document.purge_after,
    overdue: daysRemaining(document.purge_after) < 0,
    versionsRemoved: versionPaths.length,
    revokedShareLinks,
    paths: filePaths,
    backupId: backupStatus.backupId,
    backupCompletedAt: backupStatus.completedAt,
    acknowledgedBackupPolicy: !backupStatus.success,
  });

  await query('DELETE FROM documents WHERE id = $1;', [documentId]);

  // Files go last: the row is the index into them, so a failed unlink
  // leaves bytes on disk that the audit event's `paths` still names,
  // rather than a document whose content silently vanished.
  const failedFiles: string[] = [];
  let removedFiles = 0;
  for (const filePath of filePaths) {
    try {
      await fs.promises.unlink(filePath);
      removedFiles++;
    } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      failedFiles.push(filePath);
    }
  }

  if (failedFiles.length > 0) {
    await writeAuditEvent(null, actor, 'purge_incomplete', { documentId, title: document.title, failedFiles });
  }

  return {
    documentId,
    title: document.title,
    removedFiles,
    failedFiles,
    revokedShareLinks,
    versionsRemoved: versionPaths.length,
  };
}

export interface PurgeExpiredResult {
  purged: PurgeResult[];
  skipped: { documentId: string; reason: TrashErrorReason; error: string }[];
}

/**
 * Purges every document whose recovery window has elapsed. Still an
 * explicit, authorized admin action rather than a scheduler: the roadmap
 * gives users 90 days of recoverability, and nothing silently destroys
 * content on day 91. Documents that fail a guard are reported, not forced.
 */
export async function purgeExpiredDocuments(actor: TrashActor, options: PurgeOptions = {}): Promise<PurgeExpiredResult> {
  // Ticket #34 -- a sweep must not destroy what its runner cannot even see.
  // Documents in someone else's private space are reported as skipped
  // rather than silently omitted, so an admin knows the sweep was partial.
  const params: any[] = [];
  const deletableClause = buildSpaceVisibilityWhereClause(
    { userId: actor.id ?? '', role: actor.role ?? '' },
    params,
    'delete'
  );
  const candidates = await query(
    `SELECT id, (${deletableClause}) AS may_purge FROM documents d
     WHERE status = 'trashed' AND purge_after IS NOT NULL AND purge_after <= CURRENT_TIMESTAMP
     ORDER BY purge_after ASC;`,
    params
  );

  const result: PurgeExpiredResult = { purged: [], skipped: [] };
  for (const row of candidates.rows) {
    if (row.may_purge !== true) {
      result.skipped.push({
        documentId: row.id,
        reason: 'space_forbidden',
        error: 'Document lives in a space you cannot purge from',
      });
      continue;
    }
    try {
      result.purged.push(await purgeDocument(row.id, actor, options));
    } catch (error: any) {
      if (error instanceof TrashError) {
        result.skipped.push({ documentId: row.id, reason: error.reason, error: error.message });
        continue;
      }
      throw error;
    }
  }
  return result;
}
