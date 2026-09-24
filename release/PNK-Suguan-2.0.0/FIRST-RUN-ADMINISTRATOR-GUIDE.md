# PNK Suguan 2.0.0 — First-Run Administrator Guide

On a genuine first run, the bundled PostgreSQL cluster is initialized in `%LOCALAPPDATA%\PNK Suguan\`, the application database is created, all migrations (0000–0012) are applied once, and the initial Administrator account is provisioned.

The generated one-time password is written to:

```text
%LOCALAPPDATA%\PNK Suguan\FIRST-RUN-ADMIN-PASSWORD.txt
```

This document contains no password. Read the file locally, sign in, and complete the forced password rotation. Password changes revoke existing sessions. Delete the one-time password file immediately after successful rotation.

The first account is Administrator, not SUPER_ADMIN. SUPER_ADMIN remains an exceptional, separately controlled emergency capability. Never copy `.env`, credentials, password files, or session material into the program folder or distribution package.

Once signed in, a new 2.0.0 installation should:

1. Record each Guro's **Duty** (Destinado / Katuwang) on the Teachers pages — duty-based generation reads this and will not infer it.
2. Encode **weekly availability** for the weeks it intends to generate — every master-ACTIVE teacher must have a record per week. The dashboard matrix's readiness marks show at a glance which weeks are ready.
3. Review **Settings**, including the backup location, so operator backups have somewhere to land.
