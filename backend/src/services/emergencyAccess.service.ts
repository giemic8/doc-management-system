import { query } from '../database/db';
import { getSpaceOrThrow, SpaceActor, SpaceError, SpaceRow } from './space.service';

/**
 * Ticket #34 -- audited, time-bounded emergency access to a private space.
 *
 * A private space is unreadable to everybody but its owner, which is the
 * point. It is also a problem the day the owner is in hospital and the
 * insurance policy is in there. Emergency access resolves that without
 * quietly reintroducing an admin backdoor:
 *
 * - only a **trusted contact the owner nominated in advance** may ask;
 * - a **second, different** trusted person (another contact, or the owner)
 *   must approve -- the two-person rule, enforced by a database CHECK as
 *   well as here, so no future code path can approve its own request;
 * - the grant **expires** on a clock that starts at approval, capped at
 *   72 hours, because an unlock that outlives the emergency is just a
 *   permanent second key;
 * - the grant is **read-only** (see spaceVisibility.service.ts): reading
 *   somebody's records to act for them is the need; changing or deleting
 *   them while they cannot object is not;
 * - every step, and every document actually opened under the grant, is
 *   **audited**, so the owner can see afterwards exactly what happened.
 *
 * Nothing here is deleted or rewritten on revoke or expiry; the row is the
 * history of the incident.
 */

export const EMERGENCY_ACCESS_MAX_HOURS = 72;
export const EMERGENCY_ACCESS_DEFAULT_HOURS = 24;

export type EmergencyStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export type EmergencyErrorReason =
  | 'not_found'
  | 'forbidden'
  | 'invalid_reason'
  | 'invalid_duration'
  | 'shared_space'
  | 'not_trusted_contact'
  | 'owner_has_access'
  | 'already_pending'
  | 'not_pending'
  | 'not_active'
  | 'self_approval';

export class EmergencyAccessError extends Error {
  public readonly status: number;
  public readonly reason: EmergencyErrorReason;
  public readonly details: Record<string, unknown>;

  constructor(
    status: number,
    reason: EmergencyErrorReason,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'EmergencyAccessError';
    this.status = status;
    this.reason = reason;
    this.details = details;
  }
}

export interface EmergencyRequestRow {
  id: string;
  space_id: string;
  requested_by: string;
  reason: string;
  requested_hours: number;
  status: EmergencyStatus;
  approved_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
}

async function audit(
  actor: SpaceActor,
  request: EmergencyRequestRow,
  action: string,
  details: Record<string, unknown> = {}
) {
  await query(`INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4);`, [
    actor.id,
    action,
    JSON.stringify({
      requestId: request.id,
      spaceId: request.space_id,
      requestedBy: request.requested_by,
      ...details,
    }),
    actor.ip ?? null,
  ]);
}

/**
 * Each decision writes with a status guard, so a second decider racing the
 * first updates nothing. Turning that into an explanation keeps the loser of
 * the race from reading a crash instead of "somebody else already decided".
 */
function assertDecided(
  row: EmergencyRequestRow | undefined,
  reason: EmergencyErrorReason,
  message: string
): EmergencyRequestRow {
  if (!row) {
    throw new EmergencyAccessError(409, reason, message);
  }
  return row;
}

async function isTrustedContact(spaceId: string, userId: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM space_trusted_contacts WHERE space_id = $1 AND user_id = $2;`, [
    spaceId,
    userId,
  ]);
  return result.rows.length > 0;
}

/**
 * The approving half of the two-person rule. The owner qualifies (they may
 * be reachable but unable to log in), any other nominated contact
 * qualifies, and the requester never does.
 */
async function assertCanDecide(space: SpaceRow, request: EmergencyRequestRow, actor: SpaceActor): Promise<void> {
  if (actor.id === request.requested_by) {
    throw new EmergencyAccessError(
      403,
      'self_approval',
      'Emergency access needs a second person; you cannot decide your own request'
    );
  }
  if (space.owner_id === actor.id) return;
  if (await isTrustedContact(space.id, actor.id)) return;

  throw new EmergencyAccessError(
    403,
    'forbidden',
    'Only the space owner or another trusted contact can decide this request'
  );
}

export async function requestEmergencyAccess(
  actor: SpaceActor,
  input: { spaceId: string; reason: string; hours?: number }
): Promise<EmergencyRequestRow> {
  let space: SpaceRow;
  try {
    space = await getSpaceOrThrow(input.spaceId);
  } catch (err) {
    if (err instanceof SpaceError) throw new EmergencyAccessError(404, 'not_found', 'Space not found');
    throw err;
  }

  if (space.kind !== 'private') {
    throw new EmergencyAccessError(
      409,
      'shared_space',
      'A shared space is opened by adding a member, not by an emergency unlock'
    );
  }
  if (space.owner_id === actor.id) {
    throw new EmergencyAccessError(409, 'owner_has_access', 'You already own this space');
  }
  if (!(await isTrustedContact(space.id, actor.id))) {
    throw new EmergencyAccessError(
      403,
      'not_trusted_contact',
      'Only a trusted contact nominated by the owner can request emergency access'
    );
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 10) {
    throw new EmergencyAccessError(
      400,
      'invalid_reason',
      'Give a reason of at least 10 characters; the owner will read it afterwards'
    );
  }

  const hours = input.hours ?? EMERGENCY_ACCESS_DEFAULT_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > EMERGENCY_ACCESS_MAX_HOURS) {
    throw new EmergencyAccessError(
      400,
      'invalid_duration',
      `Emergency access lasts between 1 and ${EMERGENCY_ACCESS_MAX_HOURS} hours`
    );
  }

  try {
    const inserted = await query(
      `INSERT INTO emergency_access_requests (space_id, requested_by, reason, requested_hours)
       VALUES ($1, $2, $3, $4) RETURNING *;`,
      [space.id, actor.id, reason, hours]
    );
    const request = inserted.rows[0] as EmergencyRequestRow;
    await audit(actor, request, 'emergency_access_requested', { reason, requestedHours: hours });
    return request;
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new EmergencyAccessError(
        409,
        'already_pending',
        'You already have an open emergency request for this space'
      );
    }
    throw err;
  }
}

async function loadPendingRequest(requestId: string): Promise<{ request: EmergencyRequestRow; space: SpaceRow }> {
  const result = await query(`SELECT * FROM emergency_access_requests WHERE id = $1;`, [requestId]);
  const request = result.rows[0] as EmergencyRequestRow | undefined;
  if (!request) {
    throw new EmergencyAccessError(404, 'not_found', 'Emergency request not found');
  }
  if (request.status !== 'pending') {
    throw new EmergencyAccessError(409, 'not_pending', `This request was already ${request.status}`);
  }
  return { request, space: await getSpaceOrThrow(request.space_id) };
}

export async function approveEmergencyAccess(
  actor: SpaceActor,
  requestId: string
): Promise<EmergencyRequestRow> {
  const { request, space } = await loadPendingRequest(requestId);
  await assertCanDecide(space, request, actor);

  // The clock starts now, not when the request was filed: an approval that
  // arrives a day late should still give the agreed window.
  const updated = await query(
    `UPDATE emergency_access_requests
     SET status = 'approved', approved_by = $2, decided_at = CURRENT_TIMESTAMP,
         expires_at = CURRENT_TIMESTAMP + (requested_hours * INTERVAL '1 hour')
     WHERE id = $1 AND status = 'pending'
     RETURNING *;`,
    [requestId, actor.id]
  );

  const approved = assertDecided(updated.rows[0], 'not_pending', 'This request was decided by somebody else');
  await audit(actor, approved, 'emergency_access_approved', {
    approvedBy: actor.id,
    expiresAt: approved.expires_at,
  });
  return approved;
}

export async function denyEmergencyAccess(actor: SpaceActor, requestId: string): Promise<EmergencyRequestRow> {
  const { request, space } = await loadPendingRequest(requestId);
  await assertCanDecide(space, request, actor);

  const updated = await query(
    `UPDATE emergency_access_requests
     SET status = 'denied', approved_by = NULL, decided_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'pending'
     RETURNING *;`,
    [requestId]
  );

  const denied = assertDecided(updated.rows[0], 'not_pending', 'This request was decided by somebody else');
  await audit(actor, denied, 'emergency_access_denied', { deniedBy: actor.id });
  return denied;
}

/**
 * Ends an approved grant before its expiry. The owner may always do this,
 * including from a hospital bed; so may whoever approved it, and so may the
 * holder once they are finished with it.
 */
export async function revokeEmergencyAccess(actor: SpaceActor, requestId: string): Promise<EmergencyRequestRow> {
  const result = await query(`SELECT * FROM emergency_access_requests WHERE id = $1;`, [requestId]);
  const request = result.rows[0] as EmergencyRequestRow | undefined;
  if (!request) {
    throw new EmergencyAccessError(404, 'not_found', 'Emergency request not found');
  }
  if (request.status !== 'approved') {
    throw new EmergencyAccessError(409, 'not_active', 'Only an approved grant can be revoked');
  }

  const space = await getSpaceOrThrow(request.space_id);
  const mayRevoke =
    space.owner_id === actor.id || request.approved_by === actor.id || request.requested_by === actor.id;
  if (!mayRevoke) {
    throw new EmergencyAccessError(403, 'forbidden', 'Only the owner, the approver, or the holder can revoke this');
  }

  const updated = await query(
    `UPDATE emergency_access_requests
     SET status = 'revoked', revoked_by = $2, revoked_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'approved'
     RETURNING *;`,
    [requestId, actor.id]
  );

  const revoked = assertDecided(updated.rows[0], 'not_active', 'This grant was already ended by somebody else');
  await audit(actor, revoked, 'emergency_access_revoked', { revokedBy: actor.id });
  return revoked;
}

export interface EmergencyRequestView extends EmergencyRequestRow {
  space_name: string;
  space_owner_id: string;
  requested_by_name: string | null;
  approved_by_name: string | null;
  /** Approved, not revoked, not yet expired -- i.e. it opens the space right now. */
  active: boolean;
  /** True when the caller is allowed to approve or deny this request. */
  can_decide: boolean;
}

/**
 * Every request the caller has a part in: ones they filed, and ones they
 * may decide because they are the owner or another nominated contact.
 */
export async function listEmergencyRequests(actor: SpaceActor): Promise<EmergencyRequestView[]> {
  const result = await query(
    `SELECT r.*, s.name AS space_name, s.owner_id AS space_owner_id,
            ru.name AS requested_by_name, au.name AS approved_by_name,
            (s.owner_id = $1 OR EXISTS (
               SELECT 1 FROM space_trusted_contacts tc
               WHERE tc.space_id = r.space_id AND tc.user_id = $1
             )) AS is_decider
     FROM emergency_access_requests r
     JOIN spaces s ON s.id = r.space_id
     LEFT JOIN users ru ON ru.id = r.requested_by
     LEFT JOIN users au ON au.id = r.approved_by
     WHERE r.requested_by = $1
        OR s.owner_id = $1
        OR EXISTS (SELECT 1 FROM space_trusted_contacts tc WHERE tc.space_id = r.space_id AND tc.user_id = $1)
     ORDER BY r.created_at DESC;`,
    [actor.id]
  );

  return result.rows.map((row: any) => {
    const { is_decider, ...request } = row;
    return {
      ...request,
      active:
        request.status === 'approved' &&
        request.expires_at !== null &&
        new Date(request.expires_at).getTime() > Date.now(),
      can_decide: request.status === 'pending' && is_decider === true && request.requested_by !== actor.id,
    } as EmergencyRequestView;
  });
}
