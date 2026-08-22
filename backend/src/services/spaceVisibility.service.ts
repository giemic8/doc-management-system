import { query } from '../database/db';

/**
 * Ticket #34 -- the space dimension of document visibility.
 *
 * Tag ACLs (acl.service.ts) answer "which KINDS of document may this
 * group read". They deliberately cannot answer "WHOSE document is this",
 * because an admin bypasses them by design. A family system needs both
 * questions answered, independently:
 *
 * - `documents.space_id IS NULL` -- the common area. Tag ACLs alone
 *   govern it, exactly as before this ticket.
 * - a **private** space -- readable only by its owner. Not by admins:
 *   administering the server is not consent to read someone's therapy
 *   letters. The only other way in is an emergency grant, which needs a
 *   second trusted person, expires, and is audited.
 * - a **shared** space -- readable by its explicit members. Admins bypass
 *   it the same way they bypass tag ACLs, because a shared household
 *   space is content the admin already administers.
 *
 * Emergency grants are READ-only on purpose. Unlocking someone's private
 * space to handle their affairs is a legitimate need; silently editing or
 * deleting what you find there is not, and an emergency is a bad moment
 * to allow irreversible changes to somebody else's records.
 *
 * Both fragments below are composed with the tag-ACL fragment by
 * acl.service.ts. Nothing else should build these predicates by hand:
 * a read path that assembles its own is a read path that will be missed
 * the next time the rule changes.
 */

export type SpacePermission = 'read' | 'write' | 'delete';

export interface SpaceAclContext {
  userId: string;
  role: string;
}

const memberColumnFor: Record<SpacePermission, string | null> = {
  read: null,
  write: 'can_write',
  delete: 'can_delete',
};

function memberCondition(permission: SpacePermission, spaceExpr: string, userParam: number): string {
  const column = memberColumnFor[permission];
  return `EXISTS (
    SELECT 1 FROM space_members sm
    WHERE sm.space_id = ${spaceExpr} AND sm.user_id = $${userParam}${column ? ` AND sm.${column} = true` : ''}
  )`;
}

/** An approved, unexpired, unrevoked grant. `status` flips on revoke, so no separate check is needed. */
export function activeEmergencyGrantCondition(spaceExpr: string, userParam: number): string {
  return `EXISTS (
    SELECT 1 FROM emergency_access_requests ear
    WHERE ear.space_id = ${spaceExpr}
      AND ear.requested_by = $${userParam}
      AND ear.status = 'approved'
      AND ear.expires_at > CURRENT_TIMESTAMP
  )`;
}

function adminSharedSpaceCondition(spaceExpr: string): string {
  return `EXISTS (SELECT 1 FROM spaces s_admin WHERE s_admin.id = ${spaceExpr} AND s_admin.kind = 'shared')`;
}

/**
 * WHERE-clause fragment enforcing the space rule for a query aliasing
 * documents as `alias`. Pushes the user id onto `params` and returns a
 * fragment referencing it. Unlike the tag-ACL fragment this is NEVER
 * empty, not even for admins: a private space binds everybody.
 */
export function buildSpaceVisibilityWhereClause(
  ctx: SpaceAclContext,
  params: any[],
  permission: SpacePermission = 'read',
  alias = 'd'
): string {
  params.push(ctx.userId);
  const userParam = params.length;
  const spaceExpr = `${alias}.space_id`;

  const branches = [`${spaceExpr} IS NULL`, memberCondition(permission, spaceExpr, userParam)];

  if (ctx.role === 'admin') {
    branches.push(adminSharedSpaceCondition(spaceExpr));
  }

  // A grant lets its holder read the space; it never lets them change it.
  if (permission === 'read') {
    branches.push(activeEmergencyGrantCondition(spaceExpr, userParam));
  }

  return `(${branches.join('\n      OR ')})`;
}

export interface SpaceAccessDecision {
  /** False when the document id does not exist. */
  documentExists: boolean;
  spaceId: string | null;
  /** Access the user holds in their own right (membership, or admin over a shared space). */
  allowedDirectly: boolean;
  /** Access the user holds only through an active emergency grant (read paths only). */
  allowedByEmergencyGrant: boolean;
}

/**
 * Single-document form of the same rule, split by source so callers can
 * tell "this person may read their own space" from "this person is
 * reading somebody's private space under an emergency unlock" -- the
 * second one has to leave an audit trail.
 */
export async function resolveSpaceAccess(
  ctx: SpaceAclContext,
  documentId: string,
  permission: SpacePermission = 'read'
): Promise<SpaceAccessDecision> {
  const directBranches = ['d.space_id IS NULL', memberCondition(permission, 'd.space_id', 2)];
  if (ctx.role === 'admin') {
    directBranches.push(adminSharedSpaceCondition('d.space_id'));
  }

  const result = await query(
    `SELECT d.space_id,
            (${directBranches.join(' OR ')}) AS allowed_directly,
            (d.space_id IS NOT NULL AND ${activeEmergencyGrantCondition('d.space_id', 2)}) AS allowed_by_grant
     FROM documents d
     WHERE d.id = $1;`,
    [documentId, ctx.userId]
  );

  const row = result.rows[0];
  if (!row) {
    return { documentExists: false, spaceId: null, allowedDirectly: false, allowedByEmergencyGrant: false };
  }

  return {
    documentExists: true,
    spaceId: row.space_id ?? null,
    allowedDirectly: row.allowed_directly === true,
    // Emergency grants never authorize a change, so a write/delete check
    // must not report one as a fallback route.
    allowedByEmergencyGrant: permission === 'read' && row.allowed_by_grant === true,
  };
}

/**
 * Records that a private space was actually read under an emergency
 * grant. The approval alone says access was possible; this says it was
 * used, on which document, and when -- which is what the owner will want
 * to see afterwards. Best-effort: an audit failure must not turn a
 * legitimate emergency read into an error.
 */
export async function recordEmergencyAccessUse(
  userId: string,
  spaceId: string,
  documentId: string
): Promise<void> {
  try {
    const grant = await query(
      `UPDATE emergency_access_requests
       SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id FROM emergency_access_requests
         WHERE space_id = $1 AND requested_by = $2 AND status = 'approved'
           AND expires_at > CURRENT_TIMESTAMP
         ORDER BY expires_at DESC
         LIMIT 1
       )
       RETURNING id, space_id, expires_at;`,
      [spaceId, userId]
    );

    if (grant.rows.length === 0) return;

    await query(
      `INSERT INTO audit_logs (document_id, user_id, action, details) VALUES ($1, $2, 'emergency_access_used', $3);`,
      [
        documentId,
        userId,
        JSON.stringify({
          requestId: grant.rows[0].id,
          spaceId: grant.rows[0].space_id,
          expiresAt: grant.rows[0].expires_at,
        }),
      ]
    );
  } catch {
    // Never let audit bookkeeping break an emergency read.
  }
}

/**
 * Whether a document sits in a private space. Outbound integrations use
 * this: a webhook endpoint is configured by whoever administers the system,
 * and shipping the title of somebody's private document to it would hand
 * out over HTTP exactly what the space rule withholds in the UI.
 *
 * Shared spaces and the common area are not private in this sense -- an
 * admin already reads both -- so only private spaces suppress the event.
 */
export async function isPrivateSpace(spaceId: string | null | undefined): Promise<boolean> {
  if (!spaceId) return false;
  const result = await query(`SELECT 1 FROM spaces WHERE id = $1 AND kind = 'private';`, [spaceId]);
  return result.rows.length > 0;
}
