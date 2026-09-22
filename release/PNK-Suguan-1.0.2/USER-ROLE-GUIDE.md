# PNK Suguan 1.0.2 — User and Role Guide

Authorization is enforced server-side.

- **Administrator (`ADMIN`)**: day-to-day user, teacher, dako, availability, schedule, report, and notification administration; can finalize, publish, and revise finalized schedules.
- **Scheduler/Encoder (`SCHEDULER`)**: encodes teachers, dako, availability, assignments, and finalized revisions; cannot finalize, publish, override assignments, manage users, read audit logs, or write notifications.
- **Viewer (`VIEWER`)**: read-only access; cannot create or modify records or generate write-protected operations.
- **SUPER_ADMIN (`SUPER_ADMIN`)**: exceptional emergency role for authorized published-schedule correction; not granted through the normal user form.

Finalized revision remains permission-controlled. Published correction remains SUPER_ADMIN-only. No role can override `LANGUAGE_MISMATCH`.
