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

## Verify (312 tests)

```bash
npm run test:unit         # ISO weeks (incl. 53), age/anniversary, eligibility, RBAC, password policy
npm run test:int          # constraints, triggers, history, services, auth/bootstrap, user management, security (test DB)
```

Integration tests need the test cluster: `PNK_TEST_DATABASE_URL` (see `.env.local`).

## Operations notes

- **Migrations** run in filename order; each file is one transaction; tracked in `schema_migrations`.
- **Clusters**: `npm run db:up` / `db:down` / `db:test-up` / `db:test-down`.
- **Logs**: `.pg/dev.log`, `.pg/test.log`.
- **Backup**: standard `pg_dump` on the `pnk` database; both clusters are disposable dev/test stores — production should use Docker/managed Postgres with the same migrations.
- **Unlocking a schedule** (FINALIZED → DRAFT) is ADMIN-only and requires a reason; it is audited as `UNLOCKED_SCHEDULE`.

## SUPER_ADMIN: provisioning, unlock secret, and password recovery

The system distinguishes three SUPER_ADMIN-related credentials. Mixing them up is the most
common operational mistake, so here they are side by side:

| Credential | What it is | Where it lives | Rotation |
|---|---|---|---|
| **SUPER_ADMIN account** | A user account holding the SUPER_ADMIN role. Signs in like any user; the only role that can administer other SUPER_ADMIN accounts (safeguard S3: normal admins cannot modify SUPER_ADMIN rows) | `users` table (argon2id hash) | Sign in → change password, or the escape-hatch script below |
| **Unlock secret** (`PNK_SUPER_ADMIN_SECRET`) | Server-side secret for the Emergency Correction dialog. Opens a temporary 30-minute correction window on ONE PUBLISHED week; week status stays PUBLISHED; every correction is audited | `.env.local` / secret store | Replace the value in `.env.local` (dev) or your secret store, then restart the app |
| **Unlock grant (runtime)** | The 30-minute window created by one successful unlock | `week_unlock_grants` table | Expires automatically; nothing to rotate |

### Provisioning a SUPER_ADMIN account

There is deliberately **no application path** that grants SUPER_ADMIN: Create/Edit User offer only
ADMIN / SCHEDULER / VIEWER. SUPER_ADMIN is provisioned by an operator directly in the database
(create the user with a one-time password — see `scripts/reset-super-admin.ts` for the argon2id
hashing pattern — insert the `user_roles` row for the SUPER_ADMIN role, and write an audit row,
`action: GRANTED_SUPER_ADMIN`).

Safeguards that remain in force: SUPER_ADMIN is never a selectable role in the UI; no code path
grants it; the account is audited like any other; deactivation revokes its sessions.

### The unlock secret

- Server-side only, compared timing-safe, fail-closed when unset; a mismatch returns the same
  generic error as a wrong role or bad state (no oracle).
- **It is not an account password** and cannot be used to sign in.
- **It is never logged, echoed, or returned to the client**; audit rows reference the unlock
  grant, never the secret.
- In production, supply it via your secret store, not `.env.local`.

### Password recovery: the escape-hatch script

The application's Reset Password flow refuses to touch SUPER_ADMIN rows unless the actor is also a
SUPER_ADMIN (safeguard S3). If the SUPER_ADMIN password is lost, use the operator script:

```bash
DATABASE_URL=… node node_modules/tsx/dist/cli.mjs scripts/reset-super-admin.ts --email <SUPER_ADMIN email>
```

It prints a one-time temporary password (CSPRNG, unambiguous alphabet — no 0/O/1/l/I), then:

- sets `must_change_password = true` (rotation forced at next login)
- revokes all of the account's active sessions
- writes an audited `RESET_USER_PASSWORD` row (the temporary secret is never stored or logged)

The script is **scoped**: it refuses any account that does not hold the SUPER_ADMIN role (use the
`/users` UI for normal accounts) and refuses INACTIVE accounts (reactivate via the UI first).

> Operator notes: the temporary password is shown once in the terminal — store it in a password
> manager immediately, and prefer rotating again after first login since it transited a terminal.
> The script intentionally accepts no password argument, so an operator never chooses (or leaves
> in shell history) another person's final password.
