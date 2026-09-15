# API Reference — Phase 1

Base URL (dev): `http://localhost:3000`. All responses: `{ "data": … }` or `{ "error": { code, message?, issues? } }`.
Auth: httpOnly cookie `pnk_session` (set by login). Every route verifies permissions server-side.

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
| GET | `/api/teachers?status=&language=` | teachers.read | List (filter by ACTIVE/INACTIVE, FILIPINO/ENGLISH) |
| POST | `/api/teachers` | teachers.write | Create (unique code, language validated) |
| GET | `/api/teachers/:id` | teachers.read | Fetch one |
| PATCH | `/api/teachers/:id` | teachers.write | Update (destination FK validated) |
| DELETE | `/api/teachers/:id?reason=` | teachers.write | **Soft** deactivation (§14), reason required |

## Dako

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/dako?status=` | dako.read | List (ACTIVE/DISABLED) |
| POST | `/api/dako` | dako.write | Create (unique code, worship day/time, language) |
| GET | `/api/dako/:id` | dako.read | Fetch one (anniversary derivable from `date_established`) |
| PATCH | `/api/dako/:id` | dako.write | Update |
| DELETE | `/api/dako/:id?reason=` | dako.write | **Soft** disable (§13), reason required |

## Weeks

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/weeks?year=` | weeks.read | List ISO weeks |
| POST | `/api/weeks` | weeks.write | Create `{ year, isoWeekNumber }` (validates week 53 existence) |
| POST | `/api/weeks/:id/status` | weeks.write | Transition DRAFT→FINALIZED→PUBLISHED; DRAFT (unlock) = ADMIN only + `reason` |

## Availability

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/availability?weekId=` | availability.read | Weekly records for a week |
| POST | `/api/availability` | availability.write | Upsert `{ teacherId, weekId, availabilityStatus, reason?, remarks? }`; ABSENT requires reason |

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
| GET | `/api/audit-logs?limit=` | audit.read (ADMIN) | Latest audit trail |

## Scheduling (future phase)

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/scheduling/generate` | scheduling.generate | **501 NOT_IMPLEMENTED** — spec §43 |

## Error codes

`VALIDATION_ERROR` (422, with Zod issues) · `UNAUTHORIZED` (401) · `FORBIDDEN` (403) ·
`NOT_FOUND` (404) · `CONFLICT` (409, e.g. slot filled, week finalized) ·
`NOT_IMPLEMENTED` (501) · `INTERNAL` (500).
