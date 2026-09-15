# Architecture Overview — Phase 1

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16 App Router, React 19 | Minimal dev-admin UI only (spec §40) |
| API | Next.js Route Handlers (`src/app/api/**`) | Thin controllers; all rules server-side (§33) |
| Services | `src/server/services/*` | TeacherService, DakoService, WeekService, AvailabilityService, AssignmentService, NotificationService, AuditService (§34) |
| Auth | argon2id + DB-backed sessions behind an AuthProvider boundary | `src/server/auth/*`; password storage swappable without schema change |
| Validation | Zod schemas (`src/lib/validation/schemas.ts`) | Mirrors DB CHECKs; applied to every API payload |
| DB | PostgreSQL 16 | UUID PKs, FKs, CHECKs, unique constraints, §31 indexes, RLS |
| ORM/Migrations | Drizzle ORM + reviewed SQL migrations (`drizzle/0000…0002`) | Runner: `scripts/migrate.ts` with dollar-quote-aware splitter |
| Tests | Vitest (unit + integration vs disposable DB) | 47 tests, all green |

## Request flow

```
UI (dev-admin pages)  /  API clients
        ↓
Route Handler (guard: session → role → permission)
        ↓
Zod schema parse
        ↓
Service (business rules, transactions, audit)
        ↓
Drizzle → PostgreSQL (constraints as final defense)
```

No business rule lives only in the frontend (§44-17). Every mutating route resolves
permissions server-side from `user_roles` — never from client input (§33).

## Key invariants enforced across layers

1. **Current Destination ≠ weekly assignment** — `teachers.current_destination_id` is a
   profile FK; weekly service goes through `assignments` only (§10/§36).
2. **Absences live in `teacher_availability`** — profile untouched (§18);
   `wasAbsentPreviousWeek()` feeds the future scheduler.
3. **Soft lifecycle only** — teachers ACTIVE/INACTIVE, dako ACTIVE/DISABLED; DELETE
   endpoints are soft-deactivations with mandatory reason (§13/§14/§29).
4. **One assignment per teacher per week** + **one slot per dako+type per week** —
   service checks (friendly errors) *and* unique indexes (final defense) (§21).
5. **Append-only trails** — `assignment_history` and `audit_logs` reject UPDATE/DELETE
   via triggers; history rows are written by trigger on every assignment insert/change (§25/§26).
6. **Derived values** — age from `birthday`, anniversary from `date_established`;
   never stored as authoritative data (§9/§12).
7. **Week lifecycle** DRAFT → FINALIZED → PUBLISHED; only ADMIN can unlock, with
   mandatory reason, fully audited (§16).
8. **Scheduling deferred** — `/api/scheduling/generate` returns 501; no algorithm code
   exists (§43), but the counting model (`v_assignment_counts`, `assignments_counting_idx`)
   and scheduler queries are ready (§35).

## Security posture

- argon2id (OWASP parameters) password hashing; tokens stored only as SHA-256 hashes.
- httpOnly + SameSite=Lax + Secure (prod) session cookie; 12h TTL; revocation on
  password change and logout.
- RBAC: ADMIN / SCHEDULER / VIEWER permission map in `src/server/auth/permissions.ts`,
  resolved server-side per request.
- Row Level Security enabled on `users`, `audit_logs`, `notifications` as
  defense-in-depth for least-privilege DB roles (active when accessed via the scoped
  roles from `docker/init/01-roles.sql`).
- Audit entries sanitize credential fields; login errors are uniform (no user enumeration).
- Secrets: `INITIAL_ADMIN_PASSWORD` supplied via env/secret-file only; bootstrap is
  idempotent and enforces `must_change_password`.
