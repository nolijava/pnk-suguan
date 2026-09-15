# Setup Guide

## Prerequisites

Any of:
- **Docker** → `docker compose up -d` (Postgres 16 on :5432; set `POSTGRES_PASSWORD`), or
- **System PostgreSQL 16**, or
- **Nothing at all** → the portable cluster manager (`scripts/portable-pg.mjs`) installs user-scope PostgreSQL binaries under `.pg/` (no admin, no service).

Node.js ≥ 22. (On machines without Node, `.tools/` can hold a portable Node install — gitignored.)

## Steps

```bash
npm install
cp .env.example .env.local        # then edit .env.local
```

`.env.local` keys:

| Key | Purpose |
|---|---|
| `DATABASE_URL` | e.g. `postgresql://pnk:pnk@127.0.0.1:5433/pnk` (portable) or :5432 (Docker) |
| `INITIAL_ADMIN_EMAIL` | The one-time administrator identity (a value, not an authorization rule) |
| `INITIAL_ADMIN_PASSWORD` or `INITIAL_ADMIN_PASSWORD_FILE` | Supplied **only** at bootstrap; never committed |

### Portable cluster quick start

```bash
npm run setup:db          # install PostgreSQL binaries into .pg/
node scripts/portable-pg.mjs start-dev    # :5433  db pnk
node scripts/portable-pg.mjs start-test   # :5434  db pnk_test
```

(If `pg_ctl start` hangs in a Git Bash console, start detached:
`(pg_ctl -D .pg/pnk-dev -l .pg/dev.log -o "-p 5433" start </dev/null >/dev/null 2>&1 &)`.)

### Databases

```bash
npm run db:migrate        # applies drizzle/*.sql to $DATABASE_URL, records schema_migrations
```

### One-time administrator bootstrap

```bash
DATABASE_URL=… INITIAL_ADMIN_EMAIL=… INITIAL_ADMIN_PASSWORD=… npm run setup:admin
```

Idempotent: re-running never duplicates or overwrites. The account starts with
`must_change_password=true`; the UI forces a password change before any other page.

## Run

```bash
npm run dev               # http://localhost:3000
npm run build && npm start
```

## Verify (47 tests)

```bash
npm run test:unit         # ISO weeks (incl. 53), age/anniversary, eligibility, RBAC, password policy
npm run test:int          # constraints, triggers, history, services, auth/bootstrap (test DB)
```

Integration tests need the test cluster: `PNK_TEST_DATABASE_URL` (see `.env.local`).

## Operations notes

- **Migrations** run in filename order; each file is one transaction; tracked in `schema_migrations`.
- **Clusters**: `npm run db:up` / `db:down` / `db:test-up` / `db:test-down`.
- **Logs**: `.pg/dev.log`, `.pg/test.log`.
- **Backup**: standard `pg_dump` on the `pnk` database; both clusters are disposable dev/test stores — production should use Docker/managed Postgres with the same migrations.
- **Unlocking a schedule** (FINALIZED → DRAFT) is ADMIN-only and requires a reason; it is audited as `UNLOCKED_SCHEDULE`.
