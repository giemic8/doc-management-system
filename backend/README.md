# DMS Backend

## Running tests

Tests run against a real Postgres instance (no mocking of the DB layer), consistent with the
rest of this codebase.

1. Start Postgres + Redis (from the repo root): `docker compose up -d postgres redis`
2. Create a dedicated test database once: `docker exec dms_postgres psql -U dms_user -d dms_db -c "CREATE DATABASE dms_db_test;"`
3. Copy `.env.test` (already checked in with sane defaults for the docker-compose setup) — adjust `DATABASE_URL`/`REDIS_HOST`/`REDIS_PORT` if your local setup differs.
4. Run `npm test` (single run) or `npm run test:watch` (watch mode).

Each test file resets the `dms_db_test` database (truncate + re-seed) via `tests/helpers/db.ts` before running, so test files don't interfere with each other. Tests run serially (`fileParallelism: false` in `vitest.config.ts`) since they share one database.
