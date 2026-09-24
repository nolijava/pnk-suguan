# PNK Suguan 2.0.0 — User and Role Guide

Authorization is enforced server-side.

- **Administrator (`ADMIN`)**: day-to-day user, teacher, dako, availability, schedule, report, and notification administration; can generate schedules by any method, finalize, publish, revise finalized schedules, create **and restore** backups, and read the audit log.
- **Scheduler/Encoder (`SCHEDULER`)**: encodes teachers, dako, availability, and assignments; can generate schedules by any method, encode finalized revisions, and **create** backups; cannot restore backups, finalize, publish, override assignments, manage users, or read audit logs.
- **Viewer (`VIEWER`)**: read-only access; cannot create or modify records, encode availability, or generate schedules.
- **SUPER_ADMIN (`SUPER_ADMIN`)**: exceptional emergency role for authorized published-schedule correction; not granted through the normal user form.

## New in 2.0.0

- **The generation gate applies to every role alike.** No role can generate a week whose availability is incomplete — the check is server-side, and blocked attempts are audited.
- **Duty-based generation** (Assign Destinado / Assign Katuwang) uses the same `scheduling.generate` permission as Auto-generate; it reads each Guro's recorded Duty.
- **Magtuturo** generation follows the module's own continuity rules and is available to the same roles that generate schedules.
- **Backups** may be created by Administrator and Scheduler/Encoder (`backups.write`); **restore** is restricted to Administrator and SUPER_ADMIN (`backups.restore`). Every attempt is audited.
- **Readiness marks** on the dashboard matrix are visible to everyone who can see the dashboard; the "Fix availability" guide appears on the Weekly Availability page for those who can encode availability.

Finalized revision remains permission-controlled. Published correction remains SUPER_ADMIN-only. No role can override `LANGUAGE_MISMATCH` or `DAKO_DISABLED`.
