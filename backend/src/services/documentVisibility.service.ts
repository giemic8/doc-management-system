/**
 * Ticket #33 -- one place that answers "which documents count as being in
 * normal use".
 *
 * Trashed documents still exist (they are recoverable for 90 days), so
 * every read path that represents normal use -- listing, search, RAG,
 * analytics, contracts, calendar feeds, exports, guest shares -- has to
 * exclude them explicitly, the same way archived documents already are.
 * Spelling that predicate out per query is how one of them ends up
 * forgotten, so callers splice these fragments in instead.
 *
 * The GoBD audit package (routes/retention.routes.ts) deliberately does
 * NOT use these: it is a compliance snapshot of everything the system
 * still holds, not a normal-use view.
 */

/** Excludes documents sitting in the trash. */
export function notTrashedCondition(alias = 'd'): string {
  return `${alias}.status <> 'trashed'`;
}

/**
 * Excludes archived and trashed documents -- the standard filter for any
 * query that answers "what does the user work with today".
 */
export function activeDocumentsCondition(alias = 'd'): string {
  return `${alias}.is_archived = FALSE AND ${notTrashedCondition(alias)}`;
}
