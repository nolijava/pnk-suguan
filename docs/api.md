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

## Assignment cell workflows (Phase 6)

Annual-schedule cells are clickable (role-gated; server still enforces everything). Three strictly separate events (§36): **Change of Suguan** (clear only — teacher stays available, NOT absent), **Teacher absent in class** (clear + weekly ABSENT with reason → excluded from NEXT week's automatic generation), **Modify** (atomic absence + replacement). Provenance for the ABSENT / [UPDATED] badges and tooltips comes from persisted audit rows via the batched `getAnnualCellInfo(year)` service call (no N+1).

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/assignments/:id/clear` | assignments.write | Body `{ clearType: "CHANGE_OF_SUGUAN" \| "TEACHER_ABSENT", reason, absentReason? }`; non-empty reason mandatory, `absentReason` required when clearType is TEACHER_ABSENT; audits `CLEARED_ASSIGNMENT` (+ `TEACHER_MARKED_ABSENT`); scoped cascade exception inside one transaction; PUBLISHED weeks rejected |
| POST | `/api/assignments/:id/replace` | assignments.write | Atomic MODIFY: original teacher ABSENT (reason required) + replacement assigned in ONE transaction; replacement validated through the SAME hard-rule evaluator as the engine — non-overrideable rules (LANGUAGE_MISMATCH, DAKO_DISABLED) reject every actor; other violations follow the ADMIN-override-with-reason flow; source is MANUAL (rule-conforming) or OVERRIDE (bypassed rule); audits `CHANGED_ASSIGNMENT` / `MANUAL_ASSIGNMENT_OVERRIDE` + `TEACHER_MARKED_ABSENT` |
| GET | `/api/assignments/:id/eligible-replacements` | assignments.read | Server-computed eligible replacement list (excludes the absent teacher, anyone already assigned this week, master-INACTIVE, weekly ABSENT/INACTIVE, NOT_ENCODED, previous-week ABSENT, language-ineligible) |

Teacher/Dako codes are now system-assigned: `PNK-G-####` (Postgres sequence, starts after the highest existing code) and `ILGD-###` — allocated by `nextval` INSIDE the create transaction (concurrency-safe, monotonic, never reused); the code fields are removed from all create/edit forms. Migration `0004_phase6_codes_cascade.sql` (approved in plan review) also migrated the legacy `ILG-D-1001…1011` dako codes to `ILGD-100…110` (audit history untouched) and extended the assignment-history cascade guard with a second transaction-local GUC used only by the authorized clear/regenerate services.

## Weekly Suguan PDF (Phase 7)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/schedule/weekly-suguan-pdf?year=&week=` | assignments.write | READ-ONLY print layer: returns the one-page 8.5×13in portrait physical form as `application/pdf` (inline). Header/title exact (`SUGUAN NG MGA GURO SA PAGSAMBA NG KABATAAN`), Distrito `MME` / Lokal `ILUGIN` defaults, `Petsa` = the ISO week's Sunday (52/53-safe, never the generation date), `WEEK NO.` = selected ISO week. Section A = ALL ACTIVE dakos × SUGO, B = ALL ACTIVE dakos × RESERBA (blank Pangalan when unassigned — never invented), C = omitted entirely at zero RESERBA_II, else only dakos WITH a RESERBA_II assignment, D = static 4 SUGO + 2 RESERBA blanks; fixed signatories (NOLI JAVA / MCCOY SUATARON) + footer `Revised September 2026`. Reads the same source of truth as the Weekly Schedule UI (`listAssignmentsForWeek`), so Phase 6 clears/absences/replacements/manual/override assignments are reflected; dako NAME only — codes never printed; DRAFT weeks get a DRAFT watermark (FINALIZED/PUBLISHED render clean). ZERO mutations guaranteed + tested (assignment/availability/master-data/audit tables untouched; PUBLISHED immutability unaffected). Row height auto-fits ALL sections A–D + signatories + footer on EXACTLY ONE page at any realistic dako count.

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
| `/` | assignments.read | Phase 5+6 Home Dashboard: year nav (‹ ›, Today, current-ISO-week indicator), **Generate Suguan button (top-right, ADMIN/SCHEDULER — Auto-generate routes to the existing Phase 4 engine flow on /schedule, Manual opens /schedule, Cancel does nothing; never generates directly)**, Annual Suguan Schedule FIRST as three stacked Dako × ISO-week tables (SUGO → RESERBA → RESERBA II; synced horizontal scroll, sticky Dako column, current-week highlight, DISABLED badge on historical disabled-dako rows, **Dako Name only — codes hidden**; assigned cells clickable for ADMIN/SCHEDULER opening the Modify/Clear/Cancel prompt; ABSENT / [UPDATED] accessible badges + persisted-data tooltips), then real-count Current Week summary + quick links |
| `/schedule` | assignments.read | Phase 5 weekly Suguan management (Phase 4 flows unchanged): ISO week nav, THREE separate sections SUGO/RESERBA/RESERBA II (**Dako Name only — codes hidden**; teacher/source/status + unassigned reason codes + candidate stats), Generate/Regenerate with the pre-generation absence warning (Proceed · Review/Modify Availability First · Cancel), Finalize/Publish, override dialog showing violated rules — LANGUAGE_MISMATCH/DAKO_DISABLED rendered as NOT overridable — PUBLISHED fully read-only; **Generate Weekly Suguan PDF** button (ADMIN/SCHEDULER) opens the Phase 7 one-page physical form for the selected week in a new tab |
| `/teachers/new`, `/teachers/[id]/edit` | teachers.write | Phase 6: Teacher Code auto-generated (PNK-G-####) / immutable — not an input |
| `/dako/new`, `/dako/[id]/edit` | dako.write | Phase 6: Dako Code auto-generated (ILGD-###) / immutable — not an input; anniversary computed note |
| `/audit-logs` | audit.read | Audit viewer |

## Master Consolidated Plan — revisions #1–#7 (Groups 1–7)

Migration `0005_master_revision.sql` (applied to dev + test): SUPER_ADMIN role seed (§3), normalized `destination_history` table — one active period per teacher AND per dako via partial unique indexes (§8/§9), trigger-guard GUC alias alignment, and the `HISTORICAL` assignment source added to `assignments_source_check` (confirmed Phase 1 constraint gap; §56). No other schema change.

**Roles:** `SUPER_ADMIN` is the §24 emergency-correction role — full ADMIN permissions plus the scoped PUBLISHED unlock. `LANGUAGE_MISMATCH` and `DAKO_DISABLED` remain non-overridable for every actor including SUPER_ADMIN.

### Schedule correction & SUPER_ADMIN unlock (E-1/E-2)

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/weeks/:id/correction` | assignments.write (service re-checks role) | `{ mode: "FINALIZED", action: "begin" \| "end", reason }` — ADMIN correction window on a FINALIZED week (status never changes; §23/Invariant 6). Audited `FINALIZED_CORRECTION_STARTED` / `FINALIZED_CORRECTION_ENDED` |
| POST | `/api/weeks/:id/correction` | SUPER_ADMIN only | `{ mode: "PUBLISHED", secret, reason }` — §24 scoped unlock: server-verified secret (env; never logged/returned), selected week only, 30-min TTL grant, week remains PUBLISHED, no status downgrade, generic failure for wrong role/secret/state. Audited `PUBLISHED_SCHEDULE_UNLOCKED`; every correction after unlock is audited. LANGUAGE_MISMATCH stays impossible after unlock |

`assertScheduleCorrectable` now gates every assignment mutation (create / change / replace / clear): DRAFT open; FINALIZED/PUBLISHED require an active correction/unlock grant held by the caller — the status column itself never changes through these paths (Invariants 6/7/8).

### Destination history (E-3, §8/§9)

A Current-Destination change is transactional: close the previous `destination_history` period (set end date), create the new one, update `teachers.current_destination_id`, audit `DESTINATION_HISTORY_UPDATED`. ONE normalized table serves both the teacher page and the dako page (`/teachers/[id]`, `/dako/[id]`). One active period per teacher and per dako (partial unique indexes); no invented dates; survives teacher INACTIVE and dako DISABLED; weekly Suguan assignments NEVER create or modify destination history (Invariant 3); clearing the destination closes (never deletes) the active period.

### Delegate / Override / ADMIN exception (§19–§22)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/scheduling/slot-candidates?weekId=&dakoId=&assignmentType=&assignmentId=` | assignments.read | Server-computed candidate list for one slot: `eligible` (only teachers passing the same `eligibilityCheck` as the engine — empty for Delegate's normal path) + `unavailable` with exact `violatedRules[]` and `overrideAllowed` (LANGUAGE_MISMATCH/DAKO_DISABLED ⇒ false, never selectable even in exception mode). The being-replaced teacher is excluded entirely on override; teachers busy elsewhere are `ALREADY_ASSIGNED_THIS_WEEK` |

Weekly `/schedule` actions: **Delegate…** on empty slots (eligible-only picker, search by name, no reason, Review → Assign ⇒ `MANUAL`); **Override…** on filled slots (eligible-only picker + mandatory audited reason, Review → Confirm Override ⇒ `OVERRIDE`); separate ADMIN **exception mode** toggle listing unavailable candidates WITH their violated rule (blocked candidates render as NOT ALLOWABLE and stay disabled); **View Unavailable Teachers** informational panel (read-only list with reasons). Server re-validates everything — the UI never grants the bypass.

### Historical Backfill (E-4, §32–§34, §56)

Scheduling go-live is configurable (`src/server/config.ts`, `SCHEDULING_GO_LIVE = { year: 2026, week: 38 }`) — never hard-coded in logic. Weeks BEFORE go-live are recorded, never generated; weeks at/after go-live are generated, never recorded. `historical.service` + `scheduling.service` enforce this server-side (`HistoricalWeekError`), so a historical week can never become a mixed AUTO week. Historical rows keep `assignment_source = HISTORICAL` forever, count toward future fairness counts (Invariant 5), never mutate master data (Invariant 4), and the language hard rule applies to historical input (rejected, never auto-corrected).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/assignments/historical` | assignments.read | Pre-go-live weeks with `recorded` flag + configured go-live |
| POST | `/api/assignments/historical` | assignments.write | `{ weekId, rows: [{ dakoId, teacherId, assignmentType }] }` — batch-record actual rows; per-row validation (existence, language, slot + teacher-week uniqueness); transactional; audited `HISTORICAL_BACKFILL_RECORDED` |
| PATCH | `/api/assignments/historical` | assignments.write (ADMIN) | `{ assignmentId, teacherId?, assignmentType?, reason }` — correction with mandatory reason; source stays HISTORICAL; audited `HISTORICAL_CORRECTION` |

`/historical` UI (assignments.read): week selector with recorded/not-recorded status, batch row editor (Dako/Suguan/Teacher with inline LANGUAGE_MISMATCH warning), recording confirmation, and the ADMIN-only Correct dialog. Linked from the main nav.

### Dashboard & weekly additions (Group 7, §28/§29)

The annual tables now show a distinct **HISTORICAL** badge (visually separate from MANUAL/OVERRIDE) on backfilled cells, and the dashboard auto-positions the synchronized horizontal scroll so the current ISO week is immediately visible when viewing the current ISO year (never for other years; full year remains scrollable). The §26 regeneration-snapshot field list (`id, weekId, dakoId, teacherId, assignmentType, assignmentSource, status, isOverride, overrideReason, assignedAt, assignedBy, updatedAt` + week identity) is asserted by test.

## Error codes

`VALIDATION_ERROR` (422, with Zod issues) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) ·
`NOT_FOUND` (404) · `CONFLICT` (409, e.g. duplicate code, already inactive/disabled, slot
filled, week finalized, historical/normal-cycle mixing) · `HISTORICAL_WEEK` (409, workflow
separation) · `NOT_IMPLEMENTED` (501) · `INTERNAL` (500).
