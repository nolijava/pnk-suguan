# PNK Suguan 2.1.0 — User and Role Guide

Authorization is enforced server-side. Navigation reflects permissions, but it is never the boundary: every page and API route checks the caller's permissions itself, and a route reached by direct URL is checked exactly as one reached from the menu.

- **Administrator (`ADMIN`)**: day-to-day user, teacher, dako, availability, schedule, report, and notification administration; can generate schedules by any method, finalize, publish, revise finalized schedules, create **and restore** backups, and read the audit log.
- **Scheduler/Encoder (`SCHEDULER`)**: encodes teachers, dako, availability, and assignments; can generate schedules by any method, encode finalized revisions, create backups, and generate report PDFs; cannot restore backups, finalize, publish, override assignments, manage users, read the audit log, or reach the backup/destinations configuration.
- **Viewer (`VIEWER`)**: read-only access to schedules, teachers, dako, history, reports (including PDF export); cannot create or modify records, encode availability, generate schedules, or restore anything.
- **SUPER_ADMIN (`SUPER_ADMIN`)**: exceptional emergency role for authorized published-schedule correction; not granted through the normal user form. See `SUPER-ADMIN-GUIDE.md`.

## Where each page lives

| Sidebar entry | Opens |
|---|---|
| **Dashboard** | Annual matrix, Generate Suguan |
| **Schedule → Weekly Schedule** | The week's SUGO / RESERBA / RESERBA II cells and the Weekly Suguan PDF |
| **Schedule → Availability** | Weekly availability encoding and the Fix availability flow |
| **Schedule → Magtuturo** | Mga Magtuturo sa Klase (teaching assignments) |
| **Schedule → Historical Backfill** | Pre-go-live assignment encoding |
| **Reports** | Every report, each with **Generate PDF**, including the Teacher Masterlist |
| **Settings → Teachers / Dako** | Master data and destination history |
| **Settings → Users** | Account and role administration (`users.manage` only) |
| **Settings → Backup/Restore** | Backups, restore, email delivery state, administrator documentation |
| **Audit** | Administrative action history (ADMIN and SUPER_ADMIN only) |

A role that lacks a permission does not receive the entry at all: Viewer sees no Users, no Backup/Restore, and no Audit. Group headers open by click, tap, or keyboard — never by hover alone.

## Permissions at a glance

| Capability | ADMIN | SCHEDULER | VIEWER | SUPER_ADMIN |
|---|---|---|---|---|
| Read schedules, teachers, dako, history, reports | yes | yes | yes | yes |
| Encode teachers / dako / availability / assignments | yes | yes | no | yes |
| Generate schedules (any method) | yes | yes | no | yes |
| Finalize / publish a week | yes | no | no | yes |
| Revise a FINALIZED week | yes | yes | no | yes |
| Override an overridable assignment rule | yes | no | no | yes |
| Create a backup | yes | yes | no | yes |
| Restore a backup | yes | no | no | yes |
| Read the audit log | yes | no | no | yes |
| Manage users | yes | no | no | yes |
| Correct a PUBLISHED week | no | no | no | yes |

## Not overridable by anyone

`LANGUAGE_MISMATCH` (a Filipino teacher on an English dako) and `DAKO_DISABLED` cannot be cleared by an override reason, by any role, including SUPER_ADMIN. The only remedy for the first is correcting the teacher's recorded language, if that is genuinely true of them.

## New in 2.1.0

- **Destination Duty is part of the relationship.** Setting a teacher's Current Destination requires choosing a Duty (Destinado / Katuwang); the duty is stored with the period and audited on both sides of the change. Teacher records still carry `duty` as the current-period mirror that duty-based generation reads.
- **Every report exports to PDF** under the same permission as viewing it (`reports.read`), always with the filters currently applied on the page. A PDF export is read-only: it changes no data and writes no audit rows.
- **Email delivery state and test send require `users.manage`.** A Viewer cannot read the configuration state or trigger a test.
- **The delivery test can only send to the signed-in administrator's own address** — never to an arbitrary recipient — and every attempt is audited (`EMAIL_TEST_SENT`).
