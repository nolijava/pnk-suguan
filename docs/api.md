# API Reference — Phases 1–2

Base URL (dev): `http://localhost:3000`. All responses: `{ "data": … }` or `{ "error": { code, message?, issues? } }`.
Auth: httpOnly cookie `pnk_session` (set by login). Every route verifies permissions server-side.

## Conventions added in Phase 2

- **List envelope**: `GET` list routes return `{ rows, total, page, pageCount }`
  (default `pageSize` 20, max 100).
- **Strict query validation**: list query parameters are parsed with `.strict()` Zod
  schemas (`src/lib/validation/query-schemas.ts`) — unknown params (e.g. `purokGrupo` on
  `/api/teachers`) are rejected with `VALIDATION_ERROR`, not ignored.
- **Allowlisted sorts**: `sort` accepts only documented keys; `order` is `asc|desc`.

## Auth

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{ email, password }` → sets session cookie; returns `{ userId, mustChangePassword }` |
| POST | `/api/auth/logout` | session | Revokes session, clears cookie |
| GET | `/api/auth/me` | session | Current user + role codes + permissions |
| POST | `/api/auth/change-password` | session | `{ currentPassword, newPassword }`; enforces strength; revokes all sessions |

## Teachers

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/teachers` | teachers.read | Search/filter/sort/paginate: `q` (code/first/middle/last/full name), `status`, `language`, `currentDestinationId`, `sort` (`code\|name\|birthday\|status\|dateOfOath`), `order`, `page`, `pageSize`. **No purok/grupo filter (final rule).** Rows include `currentDestinationName` + `currentDestinationStatus` (DISABLED indicator source) |
| POST | `/api/teachers` | teachers.write | Create (unique code, birthday not in future, language validated; `currentDestinationId` must reference an **ACTIVE** dako) → `CREATED_TEACHER` |
| GET | `/api/teachers/:id` | teachers.read | Fetch one |
| PATCH | `/api/teachers/:id` | teachers.write | Update (same validations; destination ACTIVE-only) → `UPDATED_TEACHER` with old/new |
| DELETE | `/api/teachers/:id?reason=` | teachers.write | **Soft** deactivation (§14), reason required → `DEACTIVATED_TEACHER` |
| POST | `/api/teachers/:id/reactivate` | teachers.write | Restore ACTIVE; clears current inactive fields; history preserved in audit → `REACTIVATED_TEACHER` |
| POST | `/api/teachers/:id/current-destination` | teachers.write | `{ newDestinationId: uuid\|null, reason }` — set/change/**clear** (null = clear); reason required; ACTIVE-dako-only; touches only `teachers.current_destination_id` → `CHANGED_CURRENT_DESTINATION` |

## Dako

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/dako` | dako.read | Search/filter/sort/paginate: `q` (code/name/address/purok), `status`, `language`, `purokGrupo`, `worshipDay`, `sort` (`code\|name\|worshipDay\|dateEstablished\|status`), `order`, `page`, `pageSize` |
| GET | `/api/dako/purok-groups` | dako.read | Distinct purok/grupo values for the dako filter dropdown |
| POST | `/api/dako` | dako.write | Create (unique code, worship day/time, language) → `CREATED_DAKO` |
| GET | `/api/dako/:id` | dako.read | Fetch one (anniversary derivable from `date_established`) |
| PATCH | `/api/dako/:id` | dako.write | Update → `UPDATED_DAKO` with old/new |
| DELETE | `/api/dako/:id?reason=` | dako.write | **Soft** disable (§13), reason required → `DISABLED_DAKO` (existing teacher destinations preserved) |
| POST | `/api/dako/:id/enable` | dako.write | Restore ACTIVE → `ENABLED_DAKO` |

## Weeks

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/weeks?year=` | weeks.read | List ISO weeks |
| POST | `/api/weeks` | weeks.write | Create `{ year, isoWeekNumber }` (validates week 53 existence) |
| POST | `/api/weeks/:id/status` | weeks.write | Transition DRAFT→FINALIZED→PUBLISHED; DRAFT (unlock) = ADMIN only + `reason` |

Phase 3 helpers (service level): `resolveWeek({weekId} | {year, week})`, `adjacentWeek(weekId, ±1)` (ISO start-date arithmetic — year wrap and 52/53-week years handled; adjacent weeks auto-created DRAFT), `currentWeek()`. The lifecycle map and `assertWeekMutable` are unchanged from Phase 1.

## Availability (Phase 3)

Effective-status precedence (read model): **MASTER INACTIVE > WEEKLY INACTIVE > WEEKLY ABSENT > WEEKLY AVAILABLE**; no record = `NOT_ENCODED` = not a scheduling candidate. ABSENT requires a reason. Master-INACTIVE teachers can only carry weekly INACTIVE rows. PUBLISHED weeks are locked; ADMIN correction never changes week status.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/availability?weekId=&q=&availability=&masterStatus=&language=&currentDestinationId=&sort=&order=` | availability.read | Weekly list envelope `{ rows, total, weekId }` — joined teachers⨯availability (no N+1), effective status per row, allowlisted filters incl. `availability=NOT_ENCODED\|AVAILABLE\|ABSENT\|INACTIVE_WEEKLY\|INACTIVE_MASTER`. No purokGrupo filter (reference/display only). |
| PUT / POST | `/api/availability` | availability.write | Upsert `{ teacherId, weekId, availabilityStatus, reason?, remarks? }`; ABSENT requires reason; master-INACTIVE guard; PUBLISHED lock; no-op skip; audited old→new |
| POST | `/api/availability/bulk` | availability.write | Batched save `{ changes: [...] }` (max 500, single week) — one transaction, per-row validation, per-row audit; whole batch fails on any invalid row |
| GET | `/api/availability/fill-blanks?weekId=` | availability.read | Count of Fill-Blanks targets (master-ACTIVE with no record for the week) — powers the UI confirmation |
| POST | `/api/availability/fill-blanks` | availability.write | Create AVAILABLE records for unencoded actives only; never overwrites; excludes master-INACTIVE; per-row audit |
| POST | `/api/availability/:weekId/correction` | availability.write (ADMIN) | `{ action: "begin", reason }` / `{ action: "end" }` — §8b correction window on a PUBLISHED week. Week stays PUBLISHED; `assertWeekMutable` and assignments untouched; begin requires reason; grant is ADMIN-session-scoped, 30-min TTL, audited (`UNLOCKED_AVAILABILITY_CORRECTION` / `ENDED_AVAILABILITY_CORRECTION`) |
| GET | `/api/availability/:weekId/correction` | availability.read | Correction-window state for the UI banner |

Service-level (Phase 4 scheduler inputs): `getTeacherAvailability(teacherId, weekId)`, `getPreviousWeekAvailability(teacherId, weekId)` (prior ISO week, year-wrap safe), `wasAbsentPreviousWeekBatch(weekId)` (set of teacher ids ABSENT in the prior week), `getAvailabilityHistory(teacherId, limit)`, `resolveEffectiveStatus(weekly, master)`. Whether previous-week absence hard-excludes, soft-deprioritizes, or is configurable remains a **Phase 4 scheduling decision**.

## Availability

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/availability?weekId=` | availability.read | *(superseded by the Phase 3 section above)* |
| POST | `/api/availability` | availability.write | *(superseded by the Phase 3 section above)* |

## Assignments

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/assignments?weekId=` | assignments.read | Week schedule (dako, teacher, type, status, override flag) |
| POST | `/api/assignments` | assignments.write | Create; `overrideReason` ⇒ ADMIN-only override; enforces eligibility + one-per-week + slot uniqueness |
| PATCH | `/api/assignments/:id` | assignments.write | Change teacher/type; `reason` required; writes history + audit |
| GET | `/api/assignments/:id/history` | assignments.history.read | Append-only change trail (§25) |
| GET | `/api/assignment-counts?teacherId=&dakoId=&assignmentType=` | assignments.counts.read | Scheduler counting model (§35) |

## Users (ADMIN)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/users` | users.manage | Credential-free list via `profiles` view |
| POST | `/api/users` | users.manage | Create user with role code; forces `must_change_password` |

## Notifications / Audit

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/notifications` | session | Own notifications, newest first |
| POST | `/api/notifications` | session | `{ notificationIds: [...] }` → mark read (ownership-checked) |
| GET | `/api/audit-logs?entityType=&entityId=&action=&page=&pageSize=` | audit.read (ADMIN) | Append-only trail, optionally scoped to an entity (used by the details pages); paginated, user email joined |

## Scheduling engine (Phase 4)

Server-side Suguan generation for DRAFT weeks only. Hard eligibility (never bypassed by the engine, never scored around): master-INACTIVE teacher, DISABLED dako, weekly ABSENT/INACTIVE, no record (`NOT_ENCODED`), Filipino teacher → English dako, **previous-week ABSENT** (hard exclusion from automatic scheduling only — ADMIN override allowed afterward with reason). Allocation order: every ACTIVE dako attempts SUGO then RESERBA (dakoCode order); **RESERBA_II draws only from the leftover pool** after all SUGO+RESERBA; empty leftover → `INSUFFICIENT_FOR_RESERBA_II`. Fairness: lowest historical teacher×dako×type count first, then totals / same-dako / same-type / consecutive-same-dako / last-week recency / current-destination preference / `teacherCode` — fully deterministic, no randomness. Unassigned slots carry a reason code (`NO_ELIGIBLE_CANDIDATES` · `ALL_ABSENT_LAST_WEEK` · `LANGUAGE_MISMATCH` · `INSUFFICIENT_FOR_RESERBA_II`) + per-rule exclusion stats. Generation is transaction-serialized on the week row; AUTO assignments are replaced while MANUAL/OVERRIDE rows (and their slots/teachers) are preserved; the complete previous AUTO set is snapshotted into the `REGENERATED_SCHEDULE` audit row. Week stays DRAFT→FINALIZED→PUBLISHED; PUBLISHED is permanently immutable.

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/scheduling/generate` | scheduling.generate | `{ weekId }` → generate/regenerate AUTO assignments for a DRAFT week; returns `{ weekId, regenerated, plan, inserted }`; 409 outside DRAFT |
| POST | `/api/scheduling/preview` | assignments.read | `{ weekId }` → full slot plan + unassigned reasons, no writes |
| GET | `/api/scheduling/previous-week-absences?weekId=` | assignments.read | Freshly computed (never cached) count of teachers ABSENT in the immediately preceding week — powers the pre-generation warning |
| POST | `/api/scheduling/eligibility-check` | assignments.write | `{ weekId, dakoId, teacherId }` → `{ eligible, violatedRules[], overrideAllowed }` — powers the manual-override warning flow |

**Manual overrides (§15, tightened in Phase 5):** rule-conforming assignment create/change uses `assignments.write`; a change whose PROPOSED state violates a hard rule is rejected for Scheduler/Encoder and permitted only for ADMIN with a mandatory non-empty reason, stored with `assignmentSource=OVERRIDE` and audited `MANUAL_ASSIGNMENT_OVERRIDE` (reason prefixed `[RULES: …]`). **`NON_OVERRIDEABLE_RULES = ["DAKO_DISABLED", "LANGUAGE_MISMATCH"]`** have no override path for ANY actor — an ENGLISH dako accepts ENGLISH teachers only (Filipino teacher → English dako is rejected even for ADMIN; the only path to eligibility is changing the teacher's language to ENGLISH in their Phase 2 profile), and already-assigned teachers remain structural. Overrides never touch teacher/dako master status, availability, or Current Destination.

**Audit actions:** `GENERATED_SCHEDULE` · `REGENERATED_SCHEDULE` (full previous-AUTO snapshot) · `MANUAL_ASSIGNMENT_OVERRIDE` · existing `CREATED_ASSIGNMENT`/`CHANGED_ASSIGNMENT`/finalize/publish entries.

**Migration 0003 (user-approved):** `assignment_history` deletion is permitted only inside a regeneration transaction via the transaction-local GUC `pnk.regeneration_cascade` (set with `is_local => true`; vanishes on commit/rollback). History UPDATE guard and both `audit_logs` guards remain absolutely append-only.

## Dashboard & annual schedule (Phase 5)

The Home Dashboard (`/`) is the application entry point: the **Annual Suguan Schedule** is the primary content — THREE separate vertically stacked tables (**SUGO → RESERBA → RESERBA II**), rows = dakos (a DISABLED dako stays visible only for weeks with historical assignments, badged DISABLED), columns = real ISO weeks via `isoWeeksInYear` (52/53-safe), cells = assigned teacher name (+ `MANUAL`/`OVERRIDE` text badge; `—` = unassigned). Current-ISO-week column is highlighted across all three tables only when the selected year is the current ISO year. The three tables share synchronized horizontal scrolling with a sticky Dako column.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/schedule/annual?year=` | assignments.read | Batched annual schedule for one ISO year — single join (`assignments ⋈ weeks ⋈ dako ⋈ teachers`), shaped into the three tables server-side; strictly read-only (viewing never creates weeks/rows) |

The weekly schedule page renders the same data as three separate per-type sections and reuses the Phase 4 flows unchanged (generate + absence warning, DRAFT-only regenerate with MANUAL/OVERRIDE preservation + audit snapshot, finalize/publish, PUBLISHED permanently read-only).

## UI pages (server-rendered admin)

| Path | Permission | Description |
|---|---|---|
| `/login`, `/change-password` | — / session | Auth + forced rotation |
| `/teachers` | teachers.read | Toolbar (3 filters), sortable paginated table, deactivate/reactivate dialogs |
| `/teachers/new`, `/teachers/[id]/edit` | teachers.write | Forms; ACTIVE-dako-only destination; age computed note |
| `/teachers/[id]` | teachers.read | Details: computed age/inactive duration, destination card with DISABLED indicator, set/change/clear form, audit excerpt |
| `/dako` | dako.read | Toolbar (4 filters incl. purok/grupo), sortable paginated table, disable/enable dialogs |
| `/dako/new`, `/dako/[id]/edit` | dako.write | Forms; anniversary computed note |
| `/dako/[id]` | dako.read | Details: computed anniversary (years/next/date/days), status + disable info, audit excerpt |
| `/availability` | availability.read | Phase 3 weekly encoding: ISO week nav (prev/next/current + year/week jump, 52/53-safe), effective-status filters incl. NOT_ENCODED, inline status/reason grid, batched save with unsaved-change count, Fill Blanks confirm dialog, master-inactive rows locked with explanation, PUBLISHED lock banner + ADMIN correction flow |
| `/` | assignments.read | Phase 5 Home Dashboard: year nav (‹ ›, Today, current-ISO-week indicator), Annual Suguan Schedule FIRST as three stacked Dako × ISO-week tables (SUGO → RESERBA → RESERBA II; synced horizontal scroll, sticky Dako column, current-week highlight, DISABLED badge on historical disabled-dako rows), then real-count Current Week summary + quick links |
| `/schedule` | assignments.read | Phase 5 weekly Suguan management (Phase 4 flows unchanged): ISO week nav, THREE separate sections SUGO/RESERBA/RESERBA II (teacher/source/status + unassigned reason codes + candidate stats), Generate/Regenerate with the pre-generation absence warning (Proceed · Review/Modify Availability First · Cancel), Finalize/Publish, override dialog showing violated rules — LANGUAGE_MISMATCH/DAKO_DISABLED rendered as NOT overridable — PUBLISHED fully read-only |
| `/audit-logs` | audit.read | Audit viewer |

## Error codes

`VALIDATION_ERROR` (422, with Zod issues) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) ·
`NOT_FOUND` (404) · `CONFLICT` (409, e.g. duplicate code, already inactive/disabled, slot
filled, week finalized) · `NOT_IMPLEMENTED` (501) · `INTERNAL` (500).
