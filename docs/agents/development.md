# Development Guide for Agents

Use this guide when changing or verifying code. Commands assume repository root unless a command starts with `cd`.

## Fast orientation

1. Read `CONTEXT.md`.
2. Locate route or frontend entry with `rg`.
3. Follow call into owning service and database tables.
4. Find nearby tests before editing.
5. Check `git status --short` before and after work; preserve unrelated changes.

## Verification ladder

Run smallest relevant check first, then broaden in proportion to change.

```bash
cd backend && npm run build
cd frontend && npm run build
python3 -m py_compile worker/src/*.py
```

Backend test suite needs PostgreSQL with pgvector and Redis. Dedicated test services use ports `5433` and `6380`; `backend/.env.test` supplies test credentials. Start dependencies before running:

```bash
cd backend
npm run test:infra:up
npm test
npm run test:infra:down
```

Changes spanning OCR, storage, database, or frontend need full stack smoke test:

```bash
docker compose up -d --build
curl --fail http://localhost:4000/api/health
```

Do not report dependency connection failures as product test failures. Report both passing isolated tests and unavailable integration dependencies.

## Change map

| Change | Start here | Verify |
| --- | --- | --- |
| Login, MFA, roles | `backend/src/routes/auth.routes.ts`, `backend/src/middleware/auth.ts` | `backend/tests/auth/` |
| Document CRUD/upload | `backend/src/routes/document.routes.ts` | `backend/tests/documents/` |
| Permissions | `backend/src/services/acl.service.ts` | ACL service + enforcement tests |
| Retention/audit | retention routes/services, audit routes/services | GoBD retention + audit export tests |
| OCR/metadata | `worker/src/worker.py`, `ocr_engine.py`, `ai_extractor.py` | Python compile + full-stack ingest |
| Search/RAG | hybrid search, embedding, RAG services + worker embeddings | search and RAG tests |
| UI workflow | `frontend/src/App.tsx`, matching component, `frontend/src/services/api.ts` | frontend build + browser smoke test |
| Backup | `backup/`, backup status service/route | backup scripts + admin status endpoint |
| Schema | `backend/src/database/migrations/`, migrator, seeds | backend build + complete backend tests against fresh database |

## Cross-cutting review

For every new document query or mutation, account for:

- authentication and role checks;
- tag ACL filtering;
- retention or legal hold;
- audit logging;
- encrypted-at-rest file handling;
- archived-document behavior;
- cleanup after partial file/database failures.

For AI features, keep deterministic fallback behavior when provider is unavailable. Never send more document content to remote provider than feature requires. Tests should replace provider at existing seam rather than call external model.

## Known traps

- Frontend substitutes demo documents when API fetch fails. Browser appearance alone does not prove backend works.
- Sidebar storage usage is static presentation data.
- Worker polls PostgreSQL despite BullMQ enqueue calls. Changing queue semantics requires coordinated backend and worker change.
- Versioned migrations run at backend startup. Existing migrations are immutable; every schema change adds a new ordered migration.
- Database reset requires `npm run db:reset -- --confirm=<database-name>` and runs only in explicit development or test environment.
- Docker defaults are development-only secrets. Production deployment must supply unique JWT, MFA, storage, database, and backup secrets.
