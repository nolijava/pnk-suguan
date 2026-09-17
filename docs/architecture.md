# Architecture Overview — Phases 1–2

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 16 App Router, React 19 | Phase 1: minimal dev-admin UI (spec §40). Phase 2: full Teacher/Dako admin pages on a shared design system |
| API | Next.js Route Handlers (`src/app/api/**`) + server actions | Thin controllers; all rules server-side (§33). UI mutations (server actions) call the same services through the same guards |
| Services | `src/server/services/*` | TeacherService, DakoService, WeekService, AvailabilityService, AssignmentService, NotificationService, AuditService (§34) |
| Auth | argon2id + DB-backed sessions behind an AuthProvider boundary | `src/server/auth/*`; password storage swappable without schema change |
| Validation | Zod schemas — payloads (`src/lib/validation/schemas.ts`) and list queries (`src/lib/validation/query-schemas.ts`) | Payload schemas mirror DB CHECKs; **query schemas are `.strict()`** — only allowlisted filter/sort/page params are accepted |
| DB | PostgreSQL 16 | UUID PKs, FKs, CHECKs, unique constraints, §31 indexes, RLS — **unchanged in Phase 2 (no migration)** |
| ORM/Migrations | Drizzle ORM + reviewed SQL migrations (`drizzle/0000…0002`) | Runner: `scripts/migrate.ts` with dollar-quote-aware splitter |
| Tests | Vitest (unit + integration vs disposable DB) | 96 tests, all green (47 Phase 1 + 49 Phase 2) |

## Request flow

```
UI (admin pages: server actions)  /  API clients
        ↓
Guard (session → role → permission)  — identical for actions and routes
        ↓
Zod schema parse (payload or strict query)
        ↓
Service (business rules, transactions, audit)
        ↓
Drizzle → PostgreSQL (constraints as final defense)
```

No business rule lives only in the frontend (§44-17). Every mutating operation resolves
permissions server-side from `user_roles` — never from client input (§33).

## Phase 2 — Master Data Management

Phase 2 is an **additive administrative layer** on the untouched Phase 1 schema. Its
governing principle: **master-data current state ≠ historical record** — updating current
master data must never rewrite or destroy historical scheduling information.

### List engine (search / filter / sort / pagination)

`listTeachers` and `listDako` share one envelope: `{ rows, total, page, pageCount }`
(default page size 20, max 100). Everything is server-side:

- **Search**: case-insensitive `ILIKE '%q%'`. Teachers: code, first, middle, last, and the
  concatenated full name. Dako: code, name, address, purok/grupo.
- **Filters are closed sets**: teachers — Status, Language, Current Destination **only**
  (Purok/Grupo is deliberately *not* a teacher filter; final confirmed requirement).
  Dako — Status, Language, Purok/Grupo, Worship Day (purok/grupo **is** a dako filter).
- **Sorting is allowlisted** (no client-supplied column names): teachers — code, name,
  birthday (age is derived), status, date of oath; dako — code, name, worship day,
  date established, status; each `asc`/`desc`.
- Strict Zod query schemas reject unknown parameters outright, so a `purokGrupo` param
  sent to `/api/teachers` is a validation error, not an ignored input.

### Current Destination (reference data, not scheduling)

`changeCurrentDestination(teacherId, newDestinationId | null, reason, actor)`:

- Reason **required** for set, change, and clear; every operation audited as
  `CHANGED_CURRENT_DESTINATION` with old value (nullable), new value (`null` when cleared),
  reason, user, timestamp.
- New destinations must reference an **ACTIVE** dako — enforced in the dedicated operation
  *and* in the create/edit teacher paths.
- The operation touches **only** `teachers.current_destination_id`. Assignments,
  assignment history, and availability are provably untouched (snapshot-equality tests).
- If the destination dako is later disabled, the relationship is **preserved** as
  reference data (no automatic clearing); the UI shows a DISABLED indicator, and disabled
  dako are excluded from new selections.

### Soft lifecycle with mandatory reasons

Deactivate/reactivate (teachers) and disable/enable (dako) are service operations that
refuse empty reasons and duplicate transitions. Reactivation clears the *current*
`date_inactive`/`inactive_reason` (they describe current state) while every historical
inactivity event remains recoverable through the append-only audit trail — multiple
active/inactive cycles are all preserved with their reasons.

### Computed-only values

Age (from birthday), inactive duration (from `date_inactive` while INACTIVE), and dako
anniversary (from `date_established`: years completed, next anniversary, anniversary year,
days until) are always derived — never stored as editable data. The anniversary uses real
calendar arithmetic (no `365 + isLeap` shortcut) with a documented **Feb-29 → Feb-28
convention** in non-leap anniversary years; leap-year edge cases are unit-tested.

### Design system

Shared components under `src/app/(admin)/_components/` — `DataTable` (sort links, empty
state), `Toolbar` (GET-form search + filters + reset), `Pagination`, `ConfirmDialog`
(optional mandatory reason), `StatusBadge`, `FormField`/`SelectField`/`TextAreaField`,
`StateCard`/`Notice` — plus CSS tokens in `globals.css`. Future scheduling pages reuse
the same components.

## Key invariants enforced across layers

1. **Current Destination ≠ weekly assignment** — `teachers.current_destination_id` is a
   profile FK; weekly service goes through `assignments` only (§10/§36). Destination
   operations can never modify assignments, history, or availability (tested).
2. **Absences live in `teacher_availability`** — profile untouched (§18);
   `wasAbsentPreviousWeek()` feeds the future scheduler.
3. **Soft lifecycle only** — teachers ACTIVE/INACTIVE, dako ACTIVE/DISABLED; no physical
   deletes; reason required on every deactivation/disable (§13/§14/§29).
4. **One assignment per teacher per week** + **one slot per dako+type per week** —
   service checks (friendly errors) *and* unique indexes (§21).
5. **Append-only trails** — `assignment_history` and `audit_logs` reject UPDATE/DELETE
   via triggers; history rows are written by trigger on every assignment insert/change (§25/§26).
6. **Derived values** — age from `birthday`, anniversary from `date_established`,
   inactive duration from `date_inactive`; never stored as authoritative data (§9/§12).
7. **Week lifecycle** DRAFT → FINALIZED → PUBLISHED; only ADMIN can unlock, with
   mandatory reason, fully audited (§16).
8. **List params are allowlisted** — strict query schemas; unknown filter/sort params fail
   validation rather than being ignored (Phase 2).
9. **Scheduling deferred** — `/api/scheduling/generate` returns 501; no algorithm code
   exists (§43), but the counting model (`v_assignment_counts`, `assignments_counting_idx`)
   and scheduler queries are ready (§35).
10. **Language is absolute (Phase 5)** — `NON_OVERRIDEABLE_RULES = ["DAKO_DISABLED",
    "LANGUAGE_MISMATCH"]` reject assignment create/change/override for EVERY actor,
    ADMIN included; an ENGLISH dako accepts ENGLISH teachers only, and the sole path to
    eligibility is editing the teacher's language in their Phase 2 profile (tested).
11. **Annual tables read-only + batched (Phase 5)** — the dashboard and annual API use
    ONE joined query per year (`listAssignmentsForYear`); viewing never creates weeks or
    assignments; historical assignments on DISABLED dakos stay visible, badged DISABLED.

## Phase 5 — Weekly Suguan Management UI + Home Dashboard

The dashboard lives at `/` (`src/app/(admin)/page.tsx`; the old redirect-only root was
removed). Content hierarchy: year selector → **Annual Suguan Schedule as three separate
vertically stacked tables (SUGO → RESERBA → RESERBA II)** — never one merged matrix —
then the real-count Current Week summary and quick links. The pure table builder
(`src/lib/annual.ts`) shapes one batched join into the three grids; the client component
(`annual-client.tsx`) synchronizes horizontal `scrollLeft` across the three containers,
keeps the Dako column sticky, and highlights the current ISO week column only when the
selected year is the current ISO year. `/schedule` renders the same week data as three
per-type sections and delegates every mutation to the unchanged Phase 4 services; the
override dialog mirrors `NON_OVERRIDEABLE_RULES` (language/disabled shown as not
overridable) while the server remains authoritative.

## Security posture

- argon2id (OWASP parameters) password hashing; tokens stored only as SHA-256 hashes.
- httpOnly + SameSite=Lax + Secure (prod) session cookie; 12h TTL; revocation on
  password change and logout.
- RBAC: ADMIN / SCHEDULER / VIEWER permission map in `src/server/auth/permissions.ts`,
  resolved server-side per request — Viewer has read-only master-data access; Scheduler
  manages teachers/dako/destinations but not users; Administrator has full access.
- Row Level Security enabled on `users`, `audit_logs`, `notifications` as
  defense-in-depth for least-privilege DB roles (active when accessed via the scoped
  roles from `docker/init/01-roles.sql`).
- Audit entries sanitize credential fields; login errors are uniform (no user enumeration).
- Secrets: `INITIAL_ADMIN_PASSWORD` supplied via env/secret-file only; bootstrap is
  idempotent and enforces `must_change_password`.
