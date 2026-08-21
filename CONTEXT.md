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
- **Retention lock** — active `retention_until` or `legal_hold`; blocks destructive document changes.
- **Share link** — revocable guest capability with optional password, expiry, and download limit.
- **Workflow** — stored trigger, conditions, and actions evaluated around document ingestion.
- **Audit event** — append-only record of security-sensitive or document-changing action.

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
8. Search and RAG exclude archived documents and must honor same ACL rules as document listing.

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
