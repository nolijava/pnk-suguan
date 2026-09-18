# PNK Teacher Assignment & Suguan Management System

Scheduling and administrative system for PNK (Pagkakaisa ng mga Kabataan) dako worship-service assignments: teacher master data, weekly availability, a deterministic scheduling engine (SUGO → RESERBA → RESERBA II), week lifecycle (DRAFT → FINALIZED → PUBLISHED), assignment history, audit logs, reports, notifications, and a print-ready Weekly Suguan PDF.

## Stack

- **Next.js (App Router)** + TypeScript, server components/services
- **PostgreSQL** via **Drizzle ORM** (SQL migrations, tracked in `schema_migrations`)
- **argon2id** password hashing, hashed session tokens with TTL + revocation
- **PDFKit** for the read-only Weekly Suguan physical form
- **Vitest** integration/unit suites (19 files)

## Security posture (Phase 9)

- Every API route is authenticated and permission-checked server-side (`src/server/auth/`); frontend controls are never a security boundary.
- `LANGUAGE_MISMATCH` (Filipino teacher → English dako) and `DAKO_DISABLED` are **non-overridable** — no role, including ADMIN and SUPER_ADMIN, can bypass them.
- `PUBLISHED` weeks are immutable; the only correction path is the audited, time-boxed, week-scoped SUPER_ADMIN unlock (secret via `PNK_SUPER_ADMIN_SECRET`, timing-safe compared, never logged).
- Unexpected server errors return a fixed generic body; internal details stay in server logs only.
- Login throttling: capped exponential per-account + per-IP backoff, uniform failure message (no account enumeration).
- Security headers (CSP with `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy) on every response.
- Assignment history is append-only (DB trigger guard); reports, dashboards, PDF, and notifications are strictly read-only with respect to scheduling data.

## Running

Development:

```bash
npm install
npm run db:up          # portable dev Postgres (port 5433) — see docs/setup.md
npm run db:migrate
npm run setup:admin    # INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD from .env.local
npm run dev            # http://localhost:3000
```

Production:

```bash
npm ci
npm run build
npm start              # serves the production build
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string for the app database. |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | first boot | One-time administrator bootstrap (idempotent; password never committed anywhere). |
| `PNK_SUPER_ADMIN_SECRET` | only for Published-unlock capability | Server-side secret enabling the audited SUPER_ADMIN correction window. Fail-closed: unset means the unlock endpoint refuses all requests. Set in the process environment / secret store — never in the repo. |
| `PNK_SUPER_ADMIN_UNLOCK_TTL_MS` | no | Correction-window duration override (default 30 minutes). |
| `PNK_TEST_DATABASE_URL` | tests only | Vitest integration database. Must NOT be set in the app's production environment. |

### Operational notes

- **Notifications**: an in-process timer (`src/instrumentation.ts`) runs the idempotent Dako-anniversary scan roughly every 6 hours. No external scheduler is required; restart re-arms automatically. `POST /api/notifications/scan` (ADMIN) can force a scan.
- **Migrations** run one transaction per file, tracked in `schema_migrations`; see `docs/setup.md`.
- **Backup**: standard `pg_dump` of the production database; assignment history and audit logs are append-only and must be preserved.
- **Session revocation**: logging out or changing a password invalidates the server-side session row.

## Documentation

- `docs/setup.md` — local setup
- `docs/architecture.md`, `docs/erd.md` — structure and data model
- `docs/api.md` — API surface and conventions
- `docs/decisions.md` — recorded architecture decisions
- `docs/phase9-acceptance.md` — final Phase 1–9 acceptance matrix
