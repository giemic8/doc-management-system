# DMS Backend

## Running tests

Tests use dedicated Postgres and Redis containers. From this `backend` directory, run:

```bash
npm run test:infra:up
npm test
npm run test:infra:down
```

`npm run test:integration` combines infrastructure startup and complete test execution. Stop
the test containers afterwards with `npm run test:infra:down`.

Run `npm run test:infra:down` after a failed test run too. The test Postgres data lives in a
temporary filesystem and is discarded with the container. `backend/.env.test` connects to the
isolated host ports: Postgres on `5433` and Redis on `6380`. Change those values only when the
ports conflict locally. For conflicts, set `DMS_TEST_POSTGRES_PORT` and `DMS_TEST_REDIS_PORT`
for Compose and update matching ports in `.env.test`.

Each test file resets the `dms_db_test` database (truncate + re-seed) via `tests/helpers/db.ts` before running, so test files don't interfere with each other. Tests run serially (`fileParallelism: false` in `vitest.config.ts`) since they share one database.

## Local development

The test containers are not a full development environment. Running the application requires
the normal Postgres and Redis services on ports `5432` and `6379`, plus storage and any optional
worker, Ollama, mail, or integration prerequisites needed by the feature under development. From
the repository root, `docker compose up -d postgres redis` starts the core dependencies; the full
application can be started with `docker compose up -d --build`.

## Database operations

- `npm run db:migrate` applies pending migrations without deleting application data.
- `npm run db:reset -- --confirm=<database-name>` rebuilds the configured development or test
  database and then applies all migrations. Confirmation must equal the database name from
  `DATABASE_URL`; every environment except explicit `development` or `test` is rejected.
- `npm run db:create-admin` creates one explicit administrator from `ADMIN_EMAIL`,
  `ADMIN_PASSWORD` (minimum 12 characters), and optional `ADMIN_NAME`. Supply these through a
  deployment secret mechanism; don't commit them or store them in shell scripts.

Production startup applies migrations and reference tags but creates no default administrator.
