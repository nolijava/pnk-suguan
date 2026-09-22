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

Effective-status precedence (read model): **MASTER INACTIVE > WEEKLY INACTIVE > WEEKLY ABSENT > WEEKLY AVAILABLE**; no record = `NOT_ENCODED` = not a scheduling candidate. ABSENT requires a reason. Master-INACTIVE teachers can only carry weekly INACTIVE rows. PUBLISHED weeks are locked; SUPER_ADMIN correction never changes week status.

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/availability?weekId=&q=&availability=&masterStatus=&language=&currentDestinationId=&sort=&order=` | availability.read | Weekly list envelope `{ rows, total, weekId }` — joined teachers⨯availability (no N+1), effective status per row, allowlisted filters incl. `availability=NOT_ENCODED\|AVAILABLE\|ABSENT\|INACTIVE_WEEKLY\|INACTIVE_MASTER`. No purokGrupo filter (reference/display only). |
| PUT / POST | `/api/availability` | availability.write | Upsert `{ teacherId, weekId, availabilityStatus, reason?, remarks? }`; ABSENT requires reason; master-INACTIVE guard; PUBLISHED lock; no-op skip; audited old→new |
| POST | `/api/availability/bulk` | availability.write | Batched save `{ changes: [...] }` (max 500, single week) — one transaction, per-row validation, per-row audit; whole batch fails on any invalid row |
| GET | `/api/availability/fill-blanks?weekId=` | availability.read | Count of Fill-Blanks targets (master-ACTIVE with no record for the week) — powers the UI confirmation |
| POST | `/api/availability/fill-blanks` | availability.write | Create AVAILABLE records for unencoded actives only; never overwrites; excludes master-INACTIVE; per-row audit |
| POST | `/api/availability/:weekId/correction` | availability.write + SUPER_ADMIN role | `{ action: "begin", reason }` / `{ action: "end" }` — §8b correction window on a PUBLISHED week. **SUPER_ADMIN only** (ADMIN/SCHEDULER/VIEWER denied, for both begin and end). Week stays PUBLISHED; `assertWeekMutable` and assignments untouched; begin requires reason; grant is SUPER_ADMIN-session-scoped, 30-min TTL, audited (`UNLOCKED_AVAILABILITY_CORRECTION` / `ENDED_AVAILABILITY_CORRECTION`) |
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
| GET | `/api/schedule/weekly-suguan-pdf?year=&week=` | assignments.write | READ-ONLY print layer: returns the one-page 8.5×13in portrait physical form as `application/pdf` (inline). Header/title exact (`SUGUAN NG MGA GURO SA PAGSAMBA NG KABATAAN`), printed as one compact eight-cell label/value metadata row: Distrito `MME` / Lokal `ILUGIN` defaults, `Petsa` = the ISO week's Sunday printed MM/DD/YY (52/53-safe, never the generation date), `WEEK NO.` = selected ISO week. Presentation-only conversions of stored values: `ORAS` prints compact AM/PM (`09:00`→`9AM`, `12:00`→`12PM`, `08:30`→`8:30AM`) and dako names print uppercase with Roman numerals as Arabic (`Adrineda I`→`ADRINEDA 1`, `Arenda Extension`→`ARENDA EXT.`) — the database values are never altered. Section A = ALL ACTIVE dakos × SUGO, B = ALL ACTIVE dakos × RESERBA (blank Pangalan when unassigned — never invented), C = printed **ONLY** when the week has at least one teacher assigned as RESERBA_II — with none the section is absent from the form entirely (no heading, no column-header row, no blank shell), so the form does not reserve space for a category the week does not use; when printed it lists only dakos WITH a RESERBA_II assignment, then blank form rows up to the reference's five-row block height (never invented data); A/B/C share ONE five-column grid (`DAKO | ORAS | PANGALAN | PAGTANGGAP | PAGBABAGO`) — the reference form's sixth `PAGTUPAD` column is deliberately NOT printed, and its freed width is split evenly so `PAGTANGGAP` and `PAGBABAGO` print balanced at 133.85pt each (the only intentional departure from the measured reference grid); PAGTANGGAP/PAGBABAGO are always blank physical annotation areas, D = the reference's four SUGO rows, its blank row, then two RESERBA rows; column-header rows are shaded 25% black with white bold labels; fixed signatories (NOLI JAVA left / MCCOY SUATARON right — names printed on the signing-space line with roles beneath) + footer `Revised September 2026` placed BELOW the table. Reads the same source of truth as the Weekly Schedule UI (`listAssignmentsForWeek`), so Phase 6 clears/absences/replacements/manual/override assignments are reflected; dako NAME only — codes never printed; DRAFT weeks get a DRAFT watermark (FINALIZED/PUBLISHED render clean). ZERO mutations guaranteed + tested (assignment/availability/master-data/audit tables untouched; PUBLISHED immutability unaffected). Fixed-layout drawing on explicit 612×936pt coordinates in the reference order (table border → title → metadata row → A → B → C → D → signature band → revision line below the table), one 1pt 35%-grey rule weight, white surfaces and only the reference's 25%-black header shading — the single bordered table IS the form boundary (there is no page frame). All geometry is centralized in the exported `PDF_LAYOUT` and resolved by `buildPrintedForm()`. Geometry and type are calibrated against the physical reference form (`Sugo.pdf`) as measured from the file itself: 561.6pt table width, 26.2pt metadata row, 27.6pt section-heading bands, 16.2pt body-row pitch, deliberate non-equal column widths (A/B/C widths `[81.6, 49.8, 162.5, 133.85, 133.85]`, D `[81.6, 212.3, 145.7, 122]`, each summing to the 561.6pt table exactly). Body rows use that pitch and shrink only when a week is too dense to hold the one-page rule, so sections A–D + signature band + footer stay on EXACTLY ONE page (asserted at 2/11/22/40 dakos). APPENDED PATOTOO SLIPS: page 1 is followed by **ONE page per assigned teacher row** — every row of section A (SUGO), B (RESERBA) and C (RESERBA II) whose teacher is set, in that section order and the view model's own dako order, with rows that hold no teacher skipped (an unassigned dako has no assignment to acknowledge, and nothing is invented for it); the slips are a projection of the SAME view model page 1 prints (no second query, no second data source, no independent dako/teacher lookup), so the two cannot disagree. Each slip page is the same 612 × 936pt (8.5 × 13in portrait) sheet, split into two EQUAL 468pt halves holding two identical copies of the reference Patotoo form (`Suguan Slip.pdf`, scaled by `(612 − 2 × 31.90) / 531.40 ≈ 1.0316` to keep the reference's own margin and fill the width, one copy centred in each half, copy 2's geometry exactly copy 1's + 468pt): the TOP copy is watermarked `ORIGINAL` and the BOTTOM copy `DUPLICATE`, both rotated EXACTLY 45° and drawn behind the form — new system-generated elements (the reference carries no watermark of any kind), never `DRAFT`. Printed per copy, all from the week's own row: `Pangalan` = the assigned teacher, `Tungkulin` = `GURO`, `Week - Year` = `<ISO week number>-<stored year>` of the SELECTED week (`36-2026`; never `new Date()`, never a literal), `DAKO` = the stored dako name as-is, `PETSA` = the week's Sunday MM/DD/YYYY (`09/05/2026`, the same value page 1 prints, never today's date), `ORAS` = the compact time (`08:30`→`8:30AM` via the existing `formatOras`), `GAMPANING TUTUPARIN` = SUGO / RESERBA / RESERBA II, `RESIBO BILANG` = blank (no source value; hand-filled on the physical form), signatory = the EXISTING `MCCOY SUATARON` (PASTOR) signatory, footer = `Revised September 2026`, and the reference's own seal JPEG embedded byte-for-byte. SINGLE LINE PER CELL: every populated cell is measured with `doc.widthOfString` and, if needed, the FONT SIZE is progressively reduced until the whole value fits — always rendered with `lineBreak: false`, never wrapped, ellipsized or truncated, and the cell/row/column/page geometry is fixed by the layout and never grows; the fitted size is computed ONCE per slip and reused by BOTH copies so ORIGINAL and DUPLICATE stay geometrically identical, and a value that cannot fit even at the 6pt floor is reported (logged and returned) rather than hidden. Page 1 remains byte-for-byte unchanged (asserted by comparing its drawing stream against a page-1-only render), the endpoint and its `assignments.write` RBAC are unchanged, and the position is read-only as before.

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
| `/availability` | availability.read | Phase 3 weekly encoding: ISO week nav (prev/next/current + year/week jump, 52/53-safe), effective-status filters incl. NOT_ENCODED, inline status/reason grid, batched save with unsaved-change count, Fill Blanks confirm dialog, master-inactive rows locked with explanation, PUBLISHED lock banner + SUPER_ADMIN correction flow |
| `/` | assignments.read | Phase 5+6 Home Dashboard: year nav (‹ ›, Today, current-ISO-week indicator), **Generate Suguan button (top-right, ADMIN/SCHEDULER — Auto-generate routes to the existing Phase 4 engine flow on /schedule, Manual opens /schedule, Cancel does nothing; never generates directly)**, Annual Suguan Schedule FIRST as three stacked Dako × ISO-week tables (SUGO → RESERBA → RESERBA II; synced horizontal scroll, sticky Dako column, current-week highlight, DISABLED badge on historical disabled-dako rows, **Dako Name only — codes hidden**; assigned cells clickable for ADMIN/SCHEDULER opening the Modify/Clear/Cancel prompt; ABSENT / [UPDATED] accessible badges + persisted-data tooltips), then real-count Current Week summary + quick links |
| `/schedule` | assignments.read | Phase 5 weekly Suguan management (Phase 4 flows unchanged): ISO week nav, THREE separate sections SUGO/RESERBA/RESERBA II (**Dako Name only — codes hidden**; teacher/source/status + unassigned reason codes + candidate stats), Generate/Regenerate with the pre-generation absence warning (Proceed · Review/Modify Availability First · Cancel), Finalize/Publish, override dialog showing violated rules — LANGUAGE_MISMATCH/DAKO_DISABLED rendered as NOT overridable — PUBLISHED fully read-only; **Generate Weekly Suguan PDF** button (ADMIN/SCHEDULER) opens the Phase 7 one-page physical form for the selected week in a new tab; **Emergency Correction…** dialog (SUPER_ADMIN + PUBLISHED week only) begins the §24 unlock with a password-type secret field + mandatory audited reason (body-only, cleared after every attempt) or ends the active window via a fresh non-cached state check; generic server error on wrong secret, no URL/log/localStorage exposure |
| `/teachers/new`, `/teachers/[id]/edit` | teachers.write | Phase 6: Teacher Code auto-generated (PNK-G-####) / immutable — not an input |
| `/dako/new`, `/dako/[id]/edit` | dako.write | Phase 6: Dako Code auto-generated (ILGD-###) / immutable — not an input; anniversary computed note |
| `/audit-logs` | audit.read | Audit viewer |

## Master Consolidated Plan — revisions #1–#7 (Groups 1–7)

Migration `0005_master_revision.sql` (applied to dev + test): SUPER_ADMIN role seed (§3), normalized `destination_history` table — one active period per teacher AND per dako via partial unique indexes (§8/§9), trigger-guard GUC alias alignment, and the `HISTORICAL` assignment source added to `assignments_source_check` (confirmed Phase 1 constraint gap; §56). No other schema change.

**Roles:** `SUPER_ADMIN` is the §24 emergency-correction role — full ADMIN permissions plus the scoped PUBLISHED unlock. `LANGUAGE_MISMATCH` and `DAKO_DISABLED` remain non-overridable for every actor including SUPER_ADMIN.

**Correction authority (L2):** `weeks.unlock` is the single authoritative permission for FINALIZED revision — held by SUPER_ADMIN, ADMIN and SCHEDULER/ENCODER, and never by VIEWER. The correction service checks that permission (not role names), so the API and the schedule UI agree by construction. PUBLISHED correction is unchanged: SUPER_ADMIN only, via the server-verified `PNK_SUPER_ADMIN_SECRET` unlock, and ADMIN/SCHEDULER/VIEWER are denied. The PUBLISHED availability correction window is likewise SUPER_ADMIN-only.

### Schedule correction & SUPER_ADMIN unlock (E-1/E-2)

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/weeks/:id/correction` | assignments.write + `weeks.unlock` (service re-checks) | `{ mode: "FINALIZED", action: "begin" \| "end", reason }` — revision window on a FINALIZED week, authorized by `weeks.unlock`: **SUPER_ADMIN · ADMIN · SCHEDULER/ENCODER allowed; VIEWER denied**. Status never changes (stays FINALIZED; §23/Invariant 6). Audited `FINALIZED_CORRECTION_STARTED` / `FINALIZED_CORRECTION_ENDED` |
| POST | `/api/weeks/:id/correction` | SUPER_ADMIN only | `{ mode: "PUBLISHED", secret, reason }` — §24 scoped unlock: server-verified secret (`PNK_SUPER_ADMIN_SECRET` env; body-only, never logged/returned), selected week only, 30-min TTL grant, week remains PUBLISHED, no status downgrade, generic failure for wrong role/secret/state. Audited `PUBLISHED_SCHEDULE_UNLOCKED`; every correction after unlock is audited. LANGUAGE_MISMATCH stays impossible after unlock |

`assertScheduleCorrectable` now gates every assignment mutation (create / change / replace / clear): DRAFT open; FINALIZED/PUBLISHED require an active correction/unlock grant held by the caller — the status column itself never changes through these paths (Invariants 6/7/8).

### Destination history (E-3, §8/§9)

A Current-Destination change is transactional: close the previous `destination_history` period (set end date), create the new one, update `teachers.current_destination_id`, audit `DESTINATION_HISTORY_UPDATED`. ONE normalized table serves both the teacher page and the dako page (`/teachers/[id]`, `/dako/[id]`). One active period per teacher and per dako (partial unique indexes); no invented dates; survives teacher INACTIVE and dako DISABLED; weekly Suguan assignments NEVER create or modify destination history (Invariant 3); clearing the destination closes (never deletes) the active period.

### Delegate / Override / ADMIN exception (§19–§22)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/scheduling/slot-candidates?weekId=&dakoId=&assignmentType=&assignmentId=` | assignments.read | Server-computed candidate list for one slot: `eligible` (only teachers passing the same `eligibilityCheck` as the engine — empty for Delegate's normal path) + `unavailable` with exact `violatedRules[]` and `overrideAllowed` (LANGUAGE_MISMATCH/DAKO_DISABLED ⇒ false, never selectable even in exception mode). The being-replaced teacher is excluded entirely on override; teachers busy elsewhere are `ALREADY_ASSIGNED_THIS_WEEK` |

Weekly `/schedule` actions: **Delegate…** on empty slots (eligible-only picker, search by name, no reason, Review → Assign ⇒ `MANUAL`); **Override…** on filled slots (eligible-only picker + mandatory audited reason, Review → Confirm Override ⇒ `OVERRIDE`); separate ADMIN **exception mode** toggle listing unavailable candidates WITH their violated rule (blocked candidates render as NOT ALLOWABLE and stay disabled); **View Unavailable Teachers** informational panel (read-only list with reasons). SUPER_ADMIN additionally sees **Emergency Correction…** on PUBLISHED weeks (§24 unlock begin/end). Server re-validates everything — the UI never grants the bypass.

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

`BAD_REQUEST` (400, missing/malformed request parameter or unparseable JSON body, no Zod issues) ·
`VALIDATION_ERROR` (422, with Zod issues) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) ·
`NOT_FOUND` (404) · `CONFLICT` (409, e.g. duplicate code, already inactive/disabled, slot
filled, week finalized, historical/normal-cycle mixing) · `HISTORICAL_WEEK` (409, workflow
separation) · `NOT_IMPLEMENTED` (501) · `INTERNAL` (500).

## Phase 8 — Reports + Dashboard + Notifications

Read-only reporting and the notification delivery/UI layer. **No migration, no schema change, no new
roles/permissions**; every new surface enforces existing RBAC server-side.

### Reports (all `reports.read` — ADMIN/SCHEDULER/VIEWER; SUPER_ADMIN inherits)

Server-rendered pages calling `src/server/services/reports.service.ts` (pure SELECT, set-based, no N+1,
never auto-creates weeks, HISTORICAL source preserved verbatim):

| Page | Contents |
|---|---|
| `/reports` | Index + current-year **source summary** (AUTO/MANUAL/OVERRIDE/HISTORICAL × SUGO/RESERBA/RESERBA II cross-tab) |
| `/reports/annual?year=&type=SUGO\|RESERBA\|RESERBA_II` | Annual type report: per-Dako rows (teacher, week, status, source, assignedAt) + summary (total, bySource, dako/week coverage) |
| `/reports/weekly?year=&week=` | Weekly report with A. SUGO / B. RESERBA / C. RESERBA II sections; unassigned reason codes come from the engine's read-only preview; not-started weeks are reported (never created) |
| `/reports/teacher?teacherId=&year=&source=&type=` | Teacher assignment history (name, **code for internal admin view only**, type, dako, week/year, source, assignedAt) |
| `/reports/dako?dakoId=&year=&source=&type=` | Dako assignment history |

### Anniversary notification delivery (approved in-process mechanism)

`src/instrumentation.ts` — ONE application-level timer (~every 6 hours, module-level guard against
duplicate timers during dev/HMR) calling `NotificationService.runDueAnniversaryScan()`, which reuses the
existing `dueAnniversaryNotifications()` + `recordDakoAnniversaryNotification()` unchanged. Idempotency is
authoritative in the existing `(dako, anniversaryYear, notificationType)` unique index: repeated scans are
no-ops and downtime self-heals on the next tick. Existing UTC `anniversaryStage`/`nextAnniversary` logic
untouched. Notifications never trigger any scheduling action.

| Endpoint | Permission | Behavior |
|---|---|---|
| POST | `/api/notifications/scan` | `notifications.write` (ADMIN) — runs the SAME idempotent scan on demand; returns `{ scannedDakos, dueStages, createdNotifications }` |

### Notification bell (all roles with `notifications.read`)

`_components/notification-bell.tsx` in the admin header: unread count, dropdown panel (title, message,
category label, relative timestamp), mark-as-read **owned rows only** via the existing `POST
/api/notifications`, navigation by `relatedEntityType` (`dako` → `/dako/[id]`, `week` → `/schedule`).

Tests: `tests/int/phase8.test.ts` — report fidelity/filters/source preservation, read-only proof, notifier
stage windows, scan idempotence, ADMIN-only fan-out, mark-read ownership, navigation mapping.

## Phase 9 — security hardening notes

- **Error sanitization**: unexpected (non-`AppError`) exceptions now return a fixed generic body (`500 {"error":{"code":"INTERNAL","message":"internal error"}}`); full detail remains server-side only. Intentional validation/permission errors are unchanged.
- **Login throttling**: failed logins apply a capped exponential backoff per account+IP (0.5s doubling to a 15s cap; resets on success). The response stays the uniform `Invalid credentials` — no account enumeration; correct credentials are rejected while a window is active.
- **Security headers**: every response carries `Content-Security-Policy` (default-src 'self'; frame-ancestors 'none'; no `unsafe-eval` in production — Next.js/React dev mode requires `unsafe-eval` for its dev overlay and debugging features, so it is appended only when `NODE_ENV !== "production"`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **Dependency advisory (dev-only)**: `npm audit` reports 6 moderate advisories, all in dev tooling (`vitest` mocker path-traversal via `pnpm`-style flows, `drizzle-kit`'s esbuild dev-server exposure). No known vulnerabilities affect production dependencies (next, react, postgres, pdfkit, @node-rs/argon2, zod, drizzle-orm). Upgrades (vitest ≥3.2.5, drizzle-kit ≥0.31.x) are recommended separately and are not part of Phase 9.

## Query-parameter contract (L6)

Every guarded route validates its query parameters in ONE place — `parseQuery(req, schema)` in
`src/server/api/helpers.ts` — answering `400 {"error":{"code":"BAD_REQUEST","message":"invalid query parameter — <param>: <why>"}}`.
Two failure modes this closes, both of which used to answer the sanitized 500:

1. `fail(new Error("… is required"))` — a plain `Error`, which the Phase 9 sanitizer *correctly* turns into
   `500 INTERNAL`: a server error reported for a client mistake, and useless to the caller.
2. Passing the raw string into a query, where a malformed uuid / enum / integer surfaced as a driver error
   (`invalid input syntax for type uuid`, `limit(NaN)`) and produced the same 500 — or, for `?page=abc` /
   `?year=abc`, was silently DROPPED and returned an unfiltered list as if no filter had been requested.

Contract details:

- **Authorization runs first.** `requirePermission` is awaited *before* the parameter is read, so an
  anonymous or forbidden caller still gets 401/403 and learns nothing about which parameters exist or what
  their valid ranges are.
- **Optional stays optional; supplied must be valid.** A present-but-malformed optional filter (e.g.
  `?page=abc`) is a 400, never a silent default — a silently ignored filter is indistinguishable from a
  working one.
- **422 remains for business-rule violations** (`ValidationError`) and request bodies; `BAD_REQUEST` (400) is
  specifically for a parameter the caller got wrong or omitted.
- Covered routes (15): `/api/assignments`, `/api/assignment-counts`, `/api/audit-logs`, `/api/availability`,
  `/api/availability/fill-blanks`, `/api/dako`, `/api/dako/[id]` (DELETE `reason`), `/api/teachers`,
  `/api/teachers/[id]` (DELETE `reason`), `/api/users`, `/api/weeks`, `/api/schedule/annual`,
  `/api/schedule/weekly-suguan-pdf`, `/api/scheduling/previous-week-absences`,
  `/api/scheduling/slot-candidates`.

Tests: `tests/int/query-validation.test.ts` (51) — per-route 400-vs-500 contract, no-narrowing, the
authorization-first ordering, and the named regressions.
