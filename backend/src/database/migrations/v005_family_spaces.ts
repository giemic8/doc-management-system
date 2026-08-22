import type { Migration } from './index';

/**
 * Ticket #34 -- private and shared family spaces with emergency access.
 *
 * Tag ACLs (v001) answer "which kinds of document may this group read".
 * They cannot answer "whose document is this", because an admin bypasses
 * them by design. A family system needs the second question answered
 * independently: a partner's therapy letters must stay unreadable to the
 * person who happens to administer the NAS.
 *
 * So spaces are a second, orthogonal dimension:
 *
 * - `spaces.kind = 'private'` -- exactly one member, the owner. Nobody
 *   else reads it, admins included. The only way in is an emergency
 *   grant, which needs a second trusted person and expires.
 * - `spaces.kind = 'shared'` -- explicit membership grants access.
 *   Admins bypass it exactly as they bypass tag ACLs, since a shared
 *   space is household content the admin already administers.
 * - `documents.space_id IS NULL` -- the pre-existing common area. Every
 *   document that existed before this migration lands here, so nothing
 *   becomes invisible on upgrade; tag ACLs alone still govern it.
 *
 * `ON DELETE RESTRICT` on `documents.space_id` is deliberate: dropping a
 * space must never silently move its documents into the common area
 * where everyone can read them. The space has to be emptied first.
 */
export const familySpaces: Migration = {
  version: 5,
  name: 'family_spaces',
  sql: `
    CREATE TABLE IF NOT EXISTS spaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('private', 'shared')),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_shared_name
      ON spaces (lower(name)) WHERE kind = 'shared';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_private_name
      ON spaces (owner_id, lower(name)) WHERE kind = 'private';

    -- Membership is the single readable-by predicate for both kinds; the
    -- owner is stored as a member row too, so no query needs to special-case
    -- ownership to answer "can this user read this space".
    CREATE TABLE IF NOT EXISTS space_members (
      space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      can_write BOOLEAN NOT NULL DEFAULT true,
      can_delete BOOLEAN NOT NULL DEFAULT false,
      added_by UUID REFERENCES users(id) ON DELETE SET NULL,
      added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (space_id, user_id)
    );

    -- The people an owner nominates in advance as able to take part in an
    -- emergency unlock of their private space. Nominating somebody grants
    -- them no access by itself.
    CREATE TABLE IF NOT EXISTS space_trusted_contacts (
      space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (space_id, user_id)
    );

    -- One row is the whole life of an emergency unlock: who asked, why,
    -- which second person agreed, when it stops working, and how often it
    -- was actually used. Nothing is deleted, so the history stays auditable.
    CREATE TABLE IF NOT EXISTS emergency_access_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      requested_hours INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
      approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMP WITH TIME ZONE,
      expires_at TIMESTAMP WITH TIME ZONE,
      revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TIMESTAMP WITH TIME ZONE,
      last_used_at TIMESTAMP WITH TIME ZONE,
      use_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      -- An approval is the second person's decision, so it can never be
      -- the requester's own.
      CONSTRAINT emergency_approver_is_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by)
    );

    -- A user may have at most one open request per space, so repeated
    -- clicking cannot produce a queue of approvals for one situation.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emergency_one_pending
      ON emergency_access_requests (space_id, requested_by) WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_emergency_active_grants
      ON emergency_access_requests (requested_by, space_id) WHERE status = 'approved';

    -- Recovery codes are the self-service way back into an account. They
    -- are bcrypt hashes: the plaintext is shown once, at generation, and
    -- never leaves the owner's hands -- which is what keeps an admin from
    -- minting a way into somebody's private space.
    CREATE TABLE IF NOT EXISTS user_recovery_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash VARCHAR(255) NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_live
      ON user_recovery_codes (user_id) WHERE used_at IS NULL;

    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS space_id UUID REFERENCES spaces(id) ON DELETE RESTRICT;

    CREATE INDEX IF NOT EXISTS idx_documents_space ON documents (space_id);
  `,
};
