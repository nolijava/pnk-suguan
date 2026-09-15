# Architecture Decision Records — Phase 1

**ADR-001 — Next.js monolith with service layer (no separate API server).**
Phase 1 targets a single deployable. Business rules live in `src/server/services`, imported by both route handlers and server actions, so a future split (standalone API, mobile clients) reuses the services unchanged.

**ADR-002 — Drizzle ORM with reviewed SQL migrations.**
Schema defined in TypeScript for type-safe queries; DDL shipped as reviewed SQL (`drizzle/0000…0002`). Migration 0001 is hand-authored (CHECKs, triggers, views, RLS, seeds) — drizzle-kit generate cannot express policies/functions. Runner `scripts/migrate.ts` is dollar-quote-aware and records applied files in `schema_migrations`.

**ADR-003 — `user_roles` M:N junction instead of a single `role_id`.**
The spec's later refinement requires a role system; M:N supports multi-role users (e.g. SCHEDULER+VIEWER) with server-side permission merging, and ADMIN grants are recorded (`granted_by`). Authorization never derives from email or client claims.

**ADR-004 — Triggers for assignment history; DB-level append-only.**
History must capture every assignment mutation even if a future code path forgets to write it. `fn_assignment_history()` fires AFTER INSERT/UPDATE; `assignment_history` rejects UPDATE/DELETE outright. Services add audit rows for the human-readable trail; the DB guarantees the technical trail.

**ADR-005 — Two views, no JSON blobs.**
`v_assignment_counts` is the source-agnostic scheduler counting model (teacher×dako×type with year filter) — the Phase 4 engine queries it instead of ad-hoc aggregates. `profiles` exposes users without `password_hash`. Counting also gets a dedicated index (`assignments_counting_idx`).

**ADR-006 — argon2id via `@node-rs/argon2` behind a provider boundary.**
OWASP memory/time parameters; native binding verified on the target machine. All password calls go through `src/server/auth/password.ts`, so a managed auth provider can replace storage without touching services or schema.

**ADR-007 — Bootstrap admin is secret-driven, idempotent, and role-based.**
`INITIAL_ADMIN_EMAIL` is a value (not an authorization rule); the password comes only from `INITIAL_ADMIN_PASSWORD`/`_FILE`; the ADMIN role is granted through `user_roles`; `must_change_password` forces rotation at first login; re-running never duplicates or overwrites. No fake users anywhere (§38).

**ADR-008 — Soft delete everywhere; DELETE endpoints are deactivations.**
Teachers → INACTIVE (+`date_inactive`, reason), dako → DISABLED (+`date_disabled`, reason), users → INACTIVE. FK `ON DELETE RESTRICT` from assignments makes physical deletion impossible while history exists (§29).

**ADR-009 — ISO week math in TypeScript, verified by tests.**
`src/lib/iso-week.ts` is the single authority (week 1 = contains first Thursday). Weeks rows store derived `start_date/end_date` for range queries; uniqueness is on (year, iso_week_number). Week-53 years (2020, 2026) covered by tests.

**ADR-010 — Portable Postgres for dev/test on machines without Docker.**
`.pg/` holds user-scope PostgreSQL 16 binaries (no service, no admin). The app only sees `DATABASE_URL`, so Docker (`docker-compose.yml`) and portable clusters are interchangeable. Test runs set `PNK_TEST_DATABASE_URL`, which the client prefers when present — keeping vitest deterministic.

**ADR-011 — Absence check computed, not denormalized.**
`wasAbsentPreviousWeek()` derives the previous ISO week by date arithmetic (handles year wrap into week 52/53) and queries `teacher_availability`. No cached "excluded next week" flag to go stale.

**ADR-012 — Anniversary stages derived, dedupe enforced by unique index.**
Stages (ONE_MONTH_BEFORE / APPROACHING / ONE_DAY_BEFORE / TODAY) are computed from `date_established` (month-aware boundary, Feb-29 handled). `dako_anniversary_notifications` unique key prevents duplicates even under race conditions; the daily notifier itself is a later phase (§28/§43).
