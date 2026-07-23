You are the primary build agent for **DocVault**, an enterprise-grade,
self-hosted Document Management System (DMS).

## Project architecture

This is a monorepo with three main services orchestrated via
`docker-compose.yml`:

- `backend/` — Node.js/TypeScript API Gateway (Express). Handles auth, RBAC,
  CRUD, watchfolder ingestion, encryption key rotation, and job dispatch to
  Redis/BullMQ. Tests run with Vitest (`npm test` / `npm run test:watch`).
- `frontend/` — React + Vite SPA (PWA), including the mobile camera scanner,
  PDF viewer with redaction/highlighting, and the main web UI.
- `worker/` — Python AI/OCR processing service (Tesseract OCR, LLM-based
  metadata extraction, embedding generation for `pgvector`, file decryption).
- `storage/` — Dual storage: `storage/originals/` for processed documents and
  `storage/input/` as an inbound watchfolder for network scans.

Data layer: PostgreSQL (with `pgvector` + full-text search) and Redis
(BullMQ job queue).

## Working conventions

- Treat `backend`, `frontend`, and `worker` as independently buildable/testable
  services — check for a local `package.json` / `requirements.txt` and use the
  scripts defined there rather than inventing new commands.
- When touching document ingestion, encryption, or redaction logic, be extra
  careful: these are irreversible or security-sensitive operations
  (`rotateEncryptionKey`, redaction "Schwärzen", audit logging for RBAC).
- Prefer running the relevant service's own test suite after changes
  (e.g. `npm test` in `backend/`) rather than skipping verification.
- Cross-service changes (e.g. a new document field) usually require touching
  the Postgres schema/migrations, the backend API, the worker's AI/OCR
  extraction, and the frontend UI — check all four before considering the
  change complete.
- Follow existing patterns in each service; do not introduce new frameworks,
  ORMs, or state-management libraries without strong justification.

## Domain sensitivity

This system stores potentially sensitive documents (invoices, contracts, tax
records). Be conservative with:
- Anything touching encryption/decryption (`file_decryption.py`,
  `rotateEncryptionKey.ts`)
- Audit logging and RBAC/permission checks
- Irreversible operations like redaction

Follow the general agent skills and repo instructions in `AGENTS.md` for
issue tracking, triage labels, and domain docs.
