import { query } from '../database/db';
import {
  buildSpaceVisibilityWhereClause,
  recordEmergencyAccessUse,
  resolveSpaceAccess,
  SpacePermission,
} from './spaceVisibility.service';

/**
 * Granular Tag & Folder Access Control Lists (Ticket #19).
 *
 * Design summary (documented here since this is the single source of
 * truth for the ACL semantics used across document.routes.ts,
 * search.routes.ts, and ragChat.service.ts):
 *
 * - Admins ALWAYS see everything. This system only restricts non-admin
 *   roles (`editor`, `viewer`, ...). This preserves the existing
 *   "admin can do anything" invariant used throughout the rest of the
 *   app (e.g. requireRole(['admin']) on the export/retention/webhook
 *   routes) and avoids ever locking an admin out of their own system.
 * - A document is visible to a non-admin user if EITHER:
 *     (a) the document has NO tags at all (untagged documents remain
 *         visible to everyone -- there's no ACL rule to apply, and
 *         defaulting to "hidden" for untagged documents would silently
 *         break every pre-existing document created before this feature
 *         shipped, none of which have any group_tag_permissions rows),
 *     OR
 *     (b) at least one of the document's tags is granted to at least one
 *         of the user's groups with `can_read = true` ("any matching tag
 *         grants access" -- a document tagged both "Invoices" (visible to
 *         Finance) and "Medical" (visible to nobody outside a Medical
 *         group) would still be visible to Finance under this model; this
 *         is a deliberate, simple, permissive-union semantics rather than
 *         an intersection/deny-wins model, since the ticket's own example
 *         -- "Finance can view Invoices, HR can view Payroll" -- describes
 *         independent grants, not deny rules).
 *   Equivalently: a document is HIDDEN from a non-admin user only if it
 *   has at least one tag, AND none of its tags are granted to any group
 *   the user belongs to.
 * - Backward compatibility: if NO access_groups / group_tag_permissions
 *   exist yet (the default state for every pre-existing deployment and
 *   for the entire existing test suite), this reduces to "everyone sees
 *   everything" -- i.e. this feature is opt-in and additive. Nothing
 *   changes until an admin actually creates a group and grants it tags.
 *
 * Ticket #34 adds a SECOND, independent dimension on top of this one:
 * family spaces (see spaceVisibility.service.ts). Tag ACLs say which
 * kinds of document a group may read; spaces say whose document it is.
 * Both must allow an access, and the space rule binds admins too -- it is
 * the one place where "admin sees everything" stops, because a private
 * space exists precisely to be unreadable to whoever administers the box.
 * Every function below therefore answers `tagRule AND spaceRule`, and the
 * three checks stay the only place that composition is written down.
 */

export interface AclContext {
  userId: string;
  role: string;
}

/**
 * Builds a SQL WHERE-clause FRAGMENT (plus the params it needs, appended
 * to the given `params` array in place) enforcing the visibility rule
 * above for a query already aliasing the documents table as `d`. Since
 * ticket #34 this is never empty: admins bypass the tag half but not the
 * space half.
 *
 * `params` is mutated (params pushed) and the returned fragment references
 * the new param positions relative to the CURRENT length of `params` at
 * call time -- callers must call this AFTER pushing any of their own
 * earlier params, and must splice the returned fragment into their WHERE
 * clause with `AND`.
 */
export function buildDocumentAclWhereClause(ctx: AclContext, params: any[]): string {
  // The space rule applies to everybody, so this fragment is no longer
  // empty for admins. Callers already splice it conditionally, so an
  // admin-visible fragment needs nothing from them.
  const spaceClause = buildSpaceVisibilityWhereClause(ctx, params, 'read');

  if (ctx.role === 'admin') {
    return spaceClause;
  }

  params.push(ctx.userId);
  const userIdParam = params.length;

  // Visible if EITHER the document has no tags at all, OR at least one
  // of its tags is granted (can_read) to at least one group the user
  // belongs to ("any matching tag grants access" -- a true OR/union,
  // not an AND/intersection across all of the document's tags).
  return `
    (
      NOT EXISTS (SELECT 1 FROM document_tags dt_untagged WHERE dt_untagged.document_id = d.id)
      OR EXISTS (
        SELECT 1 FROM document_tags dt_acl
        JOIN group_tag_permissions gtp ON gtp.tag_id = dt_acl.tag_id
        JOIN user_access_groups uag ON uag.group_id = gtp.group_id
        WHERE dt_acl.document_id = d.id
          AND gtp.can_read = true
          AND uag.user_id = $${userIdParam}
      )
    )
    AND ${spaceClause}
  `;
}

/**
 * The tag half of the rule for a single document. A document that does
 * not exist passes: routes answer that with their own 404, and turning it
 * into a 403 would only tell the caller less about their own mistake.
 */
async function passesTagAcl(
  ctx: AclContext,
  documentId: string,
  permissionColumn: 'can_read' | 'can_write' | 'can_delete'
): Promise<boolean> {
  if (ctx.role === 'admin') {
    return true;
  }

  const result = await query(
    `
    SELECT (
      NOT EXISTS (SELECT 1 FROM document_tags dt_untagged WHERE dt_untagged.document_id = $1)
      OR EXISTS (
        SELECT 1 FROM document_tags dt_acl
        JOIN group_tag_permissions gtp ON gtp.tag_id = dt_acl.tag_id
        JOIN user_access_groups uag ON uag.group_id = gtp.group_id
        WHERE dt_acl.document_id = $1
          AND gtp.${permissionColumn} = true
          AND uag.user_id = $2
      )
    ) AS allowed;
    `,
    [documentId, ctx.userId]
  );

  return result.rows[0]?.allowed === true;
}

/**
 * Single-document form of the composed rule, used by routes that fetch
 * one document by id (GET /:id, GET /:id/file, PUT /:id) and by
 * requireDocumentPermission. Both halves must allow the access.
 *
 * A read that only succeeds because of an emergency grant is recorded
 * here rather than at the route, so no future route can reach somebody's
 * private space without leaving the trail its owner is owed.
 */
async function resolveDocumentPermission(
  ctx: AclContext,
  documentId: string,
  permission: SpacePermission,
  tagColumn: 'can_read' | 'can_write' | 'can_delete'
): Promise<boolean> {
  const space = await resolveSpaceAccess(ctx, documentId, permission);

  // Unknown id: leave the answer to the route, which returns 404.
  if (!space.documentExists) {
    return passesTagAcl(ctx, documentId, tagColumn);
  }

  if (!space.allowedDirectly && !space.allowedByEmergencyGrant) {
    return false;
  }

  if (!(await passesTagAcl(ctx, documentId, tagColumn))) {
    return false;
  }

  if (!space.allowedDirectly && space.allowedByEmergencyGrant && space.spaceId) {
    await recordEmergencyAccessUse(ctx.userId, space.spaceId, documentId);
  }

  return true;
}

export function canUserAccessDocument(ctx: AclContext, documentId: string): Promise<boolean> {
  return resolveDocumentPermission(ctx, documentId, 'read', 'can_read');
}

/**
 * Write/delete variants, checking `can_write` / `can_delete` on the tag
 * side and the matching member column on the space side. Emergency grants
 * are read-only, so they never satisfy these.
 */
export function canUserModifyDocument(ctx: AclContext, documentId: string): Promise<boolean> {
  return resolveDocumentPermission(ctx, documentId, 'write', 'can_write');
}

export function canUserDeleteDocument(ctx: AclContext, documentId: string): Promise<boolean> {
  return resolveDocumentPermission(ctx, documentId, 'delete', 'can_delete');
}

/**
 * Logs a denied/unauthorized access attempt to the existing audit_logs
 * table, per the ticket's "Audit log entries for unauthorized access
 * attempts" acceptance criterion. Never throws -- audit logging failures
 * must not break the request that triggered them.
 */
export async function logUnauthorizedAccess(
  userId: string,
  documentId: string | null,
  action: string,
  req: { ip?: string }
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details, ip_address) VALUES ($1, $2, $3, $4, $5);`,
      [documentId, userId, 'acl_denied', JSON.stringify({ attemptedAction: action }), req.ip ?? null]
    );
  } catch {
    // Best-effort; never let audit logging break the request.
  }
}
