import { pool, query } from '../database/db';

/**
 * Ticket #34 -- family spaces.
 *
 * A space answers "whose document is this", the question tag ACLs cannot
 * answer because admins bypass them. Two kinds, and the difference is the
 * whole point of the feature:
 *
 * - **private** -- exactly one member, the owner, created by and for that
 *   person. Nobody else reads it, admins included. Trusted contacts may be
 *   nominated in advance; nominating grants nothing by itself, it only
 *   makes the emergency-unlock flow possible later.
 * - **shared** -- household content with explicit members. Admins manage
 *   and read it, exactly as they do the common area.
 *
 * Documents with `space_id IS NULL` are the common area: everything that
 * existed before this ticket, plus anything uploaded without choosing a
 * space. Nothing about them changes.
 *
 * Membership rows carry `can_write` / `can_delete` so a shared space can
 * hold read-only members; the owner's row always carries both.
 */

export type SpaceKind = 'private' | 'shared';

export type SpaceErrorReason =
  | 'not_found'
  | 'forbidden'
  | 'invalid_kind'
  | 'invalid_name'
  | 'duplicate_name'
  | 'private_space_is_single_member'
  | 'trusted_contacts_are_private_only'
  | 'owner_membership_is_permanent'
  | 'space_not_empty'
  | 'unknown_user';

/** Carries the HTTP shape of a refused space operation so routes stay thin. */
export class SpaceError extends Error {
  public readonly status: number;
  public readonly reason: SpaceErrorReason;
  public readonly details: Record<string, unknown>;

  constructor(status: number, reason: SpaceErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SpaceError';
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

export interface SpaceActor {
  id: string;
  role: string;
  ip?: string;
}

export interface SpaceRow {
  id: string;
  name: string;
  kind: SpaceKind;
  owner_id: string;
  created_at: string;
}

async function audit(actor: SpaceActor, spaceId: string, action: string, details: Record<string, unknown>) {
  await query(`INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4);`, [
    actor.id,
    action,
    JSON.stringify({ spaceId, ...details }),
    actor.ip ?? null,
  ]);
}

export async function getSpaceOrThrow(spaceId: string): Promise<SpaceRow> {
  const result = await query(`SELECT * FROM spaces WHERE id = $1;`, [spaceId]);
  if (result.rows.length === 0) {
    throw new SpaceError(404, 'not_found', 'Space not found');
  }
  return result.rows[0] as SpaceRow;
}

/**
 * Who may change a space's membership, trusted contacts, or existence.
 * The owner always may. An admin may for a shared space -- and never for a
 * private one, which is the invariant this whole ticket exists to create:
 * an admin who could add themselves as a member could read everything.
 */
export function assertCanAdministerSpace(space: SpaceRow, actor: SpaceActor): void {
  if (space.owner_id === actor.id) return;
  if (space.kind === 'shared' && actor.role === 'admin') return;
  throw new SpaceError(403, 'forbidden', 'Only the space owner can administer this space');
}

export async function createSpace(
  actor: SpaceActor,
  input: { name: string; kind: SpaceKind }
): Promise<SpaceRow> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 255) {
    throw new SpaceError(400, 'invalid_name', 'Space name must be between 1 and 255 characters');
  }
  if (input.kind !== 'private' && input.kind !== 'shared') {
    throw new SpaceError(400, 'invalid_kind', "Space kind must be 'private' or 'shared'");
  }
  // A shared space is household infrastructure, so it is created by whoever
  // administers the household. A private space is anybody's to create.
  if (input.kind === 'shared' && actor.role !== 'admin') {
    throw new SpaceError(403, 'forbidden', 'Only an administrator can create a shared space');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO spaces (name, kind, owner_id) VALUES ($1, $2, $3) RETURNING *;`,
      [name, input.kind, actor.id]
    );
    const space = inserted.rows[0] as SpaceRow;

    // The owner is stored as an ordinary member row so every visibility
    // query can ask one question ("is this user a member") instead of two.
    await client.query(
      `INSERT INTO space_members (space_id, user_id, can_write, can_delete, added_by)
       VALUES ($1, $2, true, true, $2);`,
      [space.id, actor.id]
    );
    await client.query('COMMIT');

    await audit(actor, space.id, 'space_created', { name: space.name, kind: space.kind });
    return space;
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err?.code === '23505') {
      throw new SpaceError(409, 'duplicate_name', 'A space with that name already exists');
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface SpaceSummary extends SpaceRow {
  owner_name: string | null;
  member_count: number;
  document_count: number;
  /** True when the caller may read the space's documents right now. */
  accessible: boolean;
  /** True when the caller only sees the space because they are a nominated trusted contact. */
  trusted_contact: boolean;
}

/**
 * Spaces the caller has any legitimate reason to see. Membership is one
 * reason; being a nominated trusted contact is another, because you cannot
 * request an emergency unlock for a space you cannot name. Admins also see
 * private spaces they are not in -- name, owner and counts only, with
 * `accessible: false` -- so the household stays administrable without the
 * contents ever being readable.
 */
export async function listSpacesForUser(actor: SpaceActor): Promise<SpaceSummary[]> {
  const visibilityCondition =
    actor.role === 'admin'
      ? 'TRUE'
      : `(
          EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = $1)
          OR EXISTS (SELECT 1 FROM space_trusted_contacts tc WHERE tc.space_id = s.id AND tc.user_id = $1)
        )`;

  const result = await query(
    `SELECT s.*, u.name AS owner_name,
            (SELECT COUNT(*)::int FROM space_members sm WHERE sm.space_id = s.id) AS member_count,
            (SELECT COUNT(*)::int FROM documents d WHERE d.space_id = s.id) AS document_count,
            EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.user_id = $1) AS is_member,
            EXISTS (SELECT 1 FROM space_trusted_contacts tc WHERE tc.space_id = s.id AND tc.user_id = $1) AS is_trusted_contact
     FROM spaces s
     LEFT JOIN users u ON u.id = s.owner_id
     WHERE ${visibilityCondition}
     ORDER BY s.kind ASC, s.name ASC;`,
    [actor.id]
  );

  return result.rows.map((row: any) => {
    const { is_member, is_trusted_contact, ...space } = row;
    return {
      ...space,
      accessible: is_member === true || (actor.role === 'admin' && row.kind === 'shared'),
      trusted_contact: is_trusted_contact === true,
    } as SpaceSummary;
  });
}

export interface SpaceDetail extends SpaceSummary {
  members: Array<{ user_id: string; name: string | null; email: string | null; can_write: boolean; can_delete: boolean }>;
  trusted_contacts: Array<{ user_id: string; name: string | null; email: string | null }>;
}

export async function getSpaceDetail(actor: SpaceActor, spaceId: string): Promise<SpaceDetail> {
  const space = await getSpaceOrThrow(spaceId);

  const membership = await query(`SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2;`, [
    spaceId,
    actor.id,
  ]);
  const trusted = await query(`SELECT 1 FROM space_trusted_contacts WHERE space_id = $1 AND user_id = $2;`, [
    spaceId,
    actor.id,
  ]);

  const isMember = membership.rows.length > 0;
  const isTrusted = trusted.rows.length > 0;
  // Admins may see a space's metadata -- name, owner, who is in it -- so the
  // household stays administrable. `accessible` below still says no for a
  // private space, and it is `accessible` that gates the documents.
  const adminMetadataView = actor.role === 'admin';

  if (!isMember && !isTrusted && !adminMetadataView) {
    throw new SpaceError(403, 'forbidden', 'You cannot view this space');
  }

  const members = await query(
    `SELECT sm.user_id, u.name, u.email, sm.can_write, sm.can_delete
     FROM space_members sm LEFT JOIN users u ON u.id = sm.user_id
     WHERE sm.space_id = $1 ORDER BY u.name ASC;`,
    [spaceId]
  );
  const contacts = await query(
    `SELECT tc.user_id, u.name, u.email
     FROM space_trusted_contacts tc LEFT JOIN users u ON u.id = tc.user_id
     WHERE tc.space_id = $1 ORDER BY u.name ASC;`,
    [spaceId]
  );
  const counts = await query(
    `SELECT (SELECT COUNT(*)::int FROM documents d WHERE d.space_id = $1) AS document_count,
            (SELECT name FROM users WHERE id = $2) AS owner_name;`,
    [spaceId, space.owner_id]
  );

  return {
    ...space,
    owner_name: counts.rows[0].owner_name,
    member_count: members.rows.length,
    document_count: counts.rows[0].document_count,
    accessible: isMember || (adminMetadataView && space.kind === 'shared'),
    trusted_contact: isTrusted,
    members: members.rows as SpaceDetail['members'],
    trusted_contacts: contacts.rows as SpaceDetail['trusted_contacts'],
  };
}

async function assertUserExists(userId: string): Promise<void> {
  const user = await query(`SELECT 1 FROM users WHERE id = $1;`, [userId]);
  if (user.rows.length === 0) {
    throw new SpaceError(404, 'unknown_user', 'User not found');
  }
}

export async function addMember(
  actor: SpaceActor,
  spaceId: string,
  input: { userId: string; canWrite?: boolean; canDelete?: boolean }
): Promise<void> {
  const space = await getSpaceOrThrow(spaceId);
  assertCanAdministerSpace(space, actor);

  // Adding a member to a private space would quietly turn it into a shared
  // one. Sharing is a decision that deserves its own space.
  if (space.kind === 'private') {
    throw new SpaceError(
      409,
      'private_space_is_single_member',
      'A private space has exactly one member. Create a shared space to give somebody access.'
    );
  }

  await assertUserExists(input.userId);
  await query(
    `INSERT INTO space_members (space_id, user_id, can_write, can_delete, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (space_id, user_id) DO UPDATE SET can_write = $3, can_delete = $4;`,
    [spaceId, input.userId, input.canWrite ?? true, input.canDelete ?? false, actor.id]
  );

  await audit(actor, spaceId, 'space_member_added', {
    userId: input.userId,
    canWrite: input.canWrite ?? true,
    canDelete: input.canDelete ?? false,
  });
}

export async function removeMember(actor: SpaceActor, spaceId: string, userId: string): Promise<void> {
  const space = await getSpaceOrThrow(spaceId);
  assertCanAdministerSpace(space, actor);

  // Removing the owner would leave a space nobody can administer, and for a
  // private space it would leave documents nobody at all can read.
  if (space.owner_id === userId) {
    throw new SpaceError(409, 'owner_membership_is_permanent', 'The space owner cannot be removed');
  }

  await query(`DELETE FROM space_members WHERE space_id = $1 AND user_id = $2;`, [spaceId, userId]);
  await audit(actor, spaceId, 'space_member_removed', { userId });
}

export async function addTrustedContact(actor: SpaceActor, spaceId: string, userId: string): Promise<void> {
  const space = await getSpaceOrThrow(spaceId);

  // Only the owner nominates. An admin nominating themselves would be a
  // one-step route into a private space.
  if (space.owner_id !== actor.id) {
    throw new SpaceError(403, 'forbidden', 'Only the space owner nominates trusted contacts');
  }
  if (space.kind !== 'private') {
    throw new SpaceError(
      409,
      'trusted_contacts_are_private_only',
      'Trusted contacts exist to unlock private spaces; a shared space is unlocked by adding a member'
    );
  }
  if (userId === space.owner_id) {
    throw new SpaceError(400, 'forbidden', 'The owner already has access and cannot be their own trusted contact');
  }

  await assertUserExists(userId);
  await query(
    `INSERT INTO space_trusted_contacts (space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
    [spaceId, userId]
  );
  await audit(actor, spaceId, 'space_trusted_contact_added', { userId });
}

export async function removeTrustedContact(actor: SpaceActor, spaceId: string, userId: string): Promise<void> {
  const space = await getSpaceOrThrow(spaceId);
  if (space.owner_id !== actor.id) {
    throw new SpaceError(403, 'forbidden', 'Only the space owner nominates trusted contacts');
  }

  await query(`DELETE FROM space_trusted_contacts WHERE space_id = $1 AND user_id = $2;`, [spaceId, userId]);
  await audit(actor, spaceId, 'space_trusted_contact_removed', { userId });
}

export async function deleteSpace(actor: SpaceActor, spaceId: string): Promise<void> {
  const space = await getSpaceOrThrow(spaceId);
  assertCanAdministerSpace(space, actor);

  // The FK is ON DELETE RESTRICT, so this check only turns a database error
  // into an explanation. Dropping a space must never silently push its
  // documents into the common area where everybody can read them.
  const documents = await query(`SELECT COUNT(*)::int AS count FROM documents WHERE space_id = $1;`, [spaceId]);
  if (documents.rows[0].count > 0) {
    throw new SpaceError(409, 'space_not_empty', 'Move or delete the documents in this space first', {
      documentCount: documents.rows[0].count,
    });
  }

  await query(`DELETE FROM spaces WHERE id = $1;`, [spaceId]);
  await audit(actor, spaceId, 'space_deleted', { name: space.name, kind: space.kind });
}

/**
 * Whether the caller may file a document into a space. Used by upload and
 * by the move route; `null` means the common area, which stays open to
 * everybody exactly as it was before spaces existed.
 */
export async function assertCanWriteToSpace(actor: SpaceActor, spaceId: string | null): Promise<void> {
  if (!spaceId) return;

  const space = await getSpaceOrThrow(spaceId);
  if (space.kind === 'shared' && actor.role === 'admin') return;

  const member = await query(
    `SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2 AND can_write = true;`,
    [spaceId, actor.id]
  );
  if (member.rows.length === 0) {
    throw new SpaceError(403, 'forbidden', 'You cannot file documents into this space');
  }
}
