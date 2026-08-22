# DocVault Context

DocVault is a self-hosted document management system. It ingests files, preserves originals, enriches documents with OCR and AI metadata, and exposes controlled search, workflow, sharing, reporting, and retention features.

## Domain glossary

- **Document** — database record plus stored original file. Metadata may be user-authored or extracted.
- **Original** — immutable uploaded or imported file under `storage/originals/`. Derived files belong under `storage/derived/`.
- **Derived file** — generated representation such as redacted, split, or merged PDF. It never silently replaces an original.
- **Document version** — historical file snapshot recorded in `document_versions` when file content changes.
- **Processing** — OCR, metadata extraction, tagging, chunking, and embedding performed by Python worker.
- **Tag** — document classification and ACL attachment point.
- **Access group** — user collection granted read, write, or delete permission through tag permissions. Admin bypasses tag ACLs.
- **Space** — ownership dimension of a document, independent of tags. A **private space** has exactly one member, its owner, and is unreadable to everyone else including admins. A **shared space** is readable by its explicit members, and admins bypass it as they bypass tag ACLs. `space_id IS NULL` is the **common area**: tag ACLs alone govern it.
- **Trusted contact** — person the owner of a private space nominates in advance as able to take part in an emergency unlock. Nomination grants no access by itself.
- **Emergency access** — time-bounded, read-only, audited unlock of one private space. A trusted contact requests it, a second, different trusted person approves it, and it expires on a clock that starts at approval.
- **Recovery code** — single-use secret a user generates for their own account, shown once and stored hashed, redeemable to set a new password without an administrator.
- **Retention lock** — active `retention_until` or `legal_hold`; blocks destructive document changes.
- **Trash** — reversible delete. Document moves to `trashed`, keeps every stored byte, and stays restorable until `purge_after` (90 days) and beyond, as long as nobody purges it.
- **Purge** — irreversible destruction of a trashed document: both durable copies, derived files, thumbnails, versions, and the record itself. Admin-only, needs explicit confirmation, and is refused under retention lock, active share links, or an unhealthy backup state.
- **Share link** — revocable guest capability with optional password, expiry, and download limit.
- **Workflow** — stored trigger, conditions, and actions evaluated around document ingestion.
- **Audit event** — append-only record of security-sensitive or document-changing action.
- **Extraction proposal** — one extracted field value together with the confidence it was extracted at. It reaches the document only if it clears the configured bar; otherwise it is offered to a person and the column stays empty.
- **Confidence threshold** — configured bar in `review_settings` that decides whether a proposal is applied, shown to a reviewer, or withheld as too weak to suggest. Compared in the database so worker and backend cannot disagree.
- **Review inbox** — the open questions about documents: uncertain fields and duplicate candidates. An open item holds its document in `review`.
- **Duplicate candidate** — a pair of documents recorded as possibly the same content. Exact pairs are proven by hash, similar pairs are scored. A candidate is never merged; a reviewer links it or separates it, and the answer is remembered for that pair.
- **Component health** — the stored result of the latest probe of one dependency: status, last success, current failure, measured metrics, and the operator action that would fix it.
- **Incident** — one ongoing operational problem. At most one is open per component and kind; a repeat observation bumps its counter instead of raising a second one, and its resolution sends exactly one recovery notice.

## Ingestion language

- **Ingestion** — acceptance of a document from browser, watchfolder, or email into one canonical lifecycle.
- **Source identity** — stable source plus idempotency key identifying one delivery. Repeated delivery resolves to same document.
- **Received** — document record exists, but original bytes are not yet confirmed in durable storage.
- **Durable** — original bytes are stored successfully and available for processing.
- **Processing** — document is eligible for, or currently undergoing, OCR and metadata enrichment.
- **Review** — processing completed but human decision is required before normal use.
- **Ready** — document completed processing and is available for normal use.
- **Failed** — ingestion or processing stopped with actionable reason and retry path.
- **Trashed** — document is excluded from normal use pending retention-aware removal or restoration.

Split and merged PDFs enter lifecycle as **Ready**. Archive state remains separate from ingestion lifecycle.

## Invariants

1. Every document access applies authentication plus tag ACL visibility. Admin may bypass tag ACL checks.
2. Every mutation that can destroy or replace content checks retention lock first.
3. Original content remains recoverable through original or version storage unless authorized retention rules permit deletion.
4. Security-sensitive and document-changing actions append audit events.
5. Encrypted files are decrypted only into temporary files and removed after use.
6. Public share routes authenticate opaque share tokens, never normal user JWTs.
7. Calendar feed routes authenticate revocable feed tokens because calendar clients cannot send JWT headers.
8. Search, RAG, analytics, contract lists, calendar feeds, exports, and guest shares exclude archived and trashed documents, and must honor same ACL rules as document listing. Audit-log rows about an unreadable document keep the event and lose the title.
9. Deleting a document trashes it; content is destroyed only by an explicitly authorized purge, and only from `trashed`.
10. Every document access also applies the space rule, and admins are inside it: a private space is readable only by its owner. Derived documents inherit their source's space, and a merge across spaces is refused.
11. The only route into another user's private space is emergency access: a nominated trusted contact requests it, a second, different trusted person approves it, it expires, it grants read only, and both the grant and every document opened under it are audited.
12. Account recovery runs on the owner's own single-use recovery codes. No route lets an administrator reset another user's password or generate their codes.
13. Extracted metadata reaches a document only through the configured confidence thresholds. What does not clear them stays a proposal, and the document stays in `review` until a person accepts, corrects, retries or dismisses it.
14. Duplicate detection never merges, replaces or deletes a document, and never reports a counterpart from another space.
15. Review state — open items, proposals, and the similarity marker — is database state, so a worker or provider restart changes nothing about what is still owed.
16. Operational health and alerts are expressed in counts, ages and bytes. They never carry a document title, filename, sender or space name, so an administrator dashboard cannot become a side channel around tag ACLs or the space rule.
17. An alert is recorded locally before any delivery is attempted, and every attempt records its outcome. A missing or broken delivery channel leaves the incident visible rather than silent.

## Module map

- `frontend/` — React PWA. User workflows and local offline upload queue. Treat backend as authority.
- `backend/src/routes/` — HTTP interface, input validation, auth, and response mapping.
- `backend/src/services/` — business modules for ACL, retention, search, RAG, encryption, exports, integrations, and schedulers.
- `backend/src/database/` — PostgreSQL connection, versioned migrations, reset guard, and seed data.
- `worker/src/` — OCR, AI extraction, embeddings, and processing metrics.
- `storage/` — shared file storage mounted into backend and worker.
- `backup/` — encrypted database/file backup and restore verification.
- `docker-compose.yml` — runtime composition: PostgreSQL/pgvector, Redis, backend, worker, frontend, Ollama, backup.

## External seams

- PostgreSQL: document state, metadata, permissions, audit, embeddings.
- Filesystem: originals, derived files, thumbnails, watchfolder.
- Redis: rate-limit counters.
- Ollama or OpenAI: metadata extraction, embeddings, and RAG answers.
- IMAP: inbound email attachments.
- Webhooks, iCal, DATEV, and guest shares: outbound/public interfaces.

Keep provider-specific behavior behind existing service modules. New callers should not instantiate database, Redis, filesystem, or LLM clients when an owning module already exists.
