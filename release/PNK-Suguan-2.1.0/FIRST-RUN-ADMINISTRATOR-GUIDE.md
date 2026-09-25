# PNK Suguan 2.1.0 — First-Run Administrator Guide

On a genuine first run, the bundled PostgreSQL cluster is initialized in `%LOCALAPPDATA%\PNK Suguan\`, the application database is created, all migrations (0000–0013) are applied once, and the initial Administrator account is provisioned.

The generated one-time password is written to:

```text
%LOCALAPPDATA%\PNK Suguan\FIRST-RUN-ADMIN-PASSWORD.txt
```

This document contains no password. Read the file locally, sign in, and complete the forced password rotation. Password changes revoke existing sessions. Delete the one-time password file immediately after successful rotation.

The first account is Administrator, not SUPER_ADMIN. SUPER_ADMIN remains an exceptional, separately controlled emergency capability. Never copy `.env`, credentials, password files, or session material into the program folder or distribution package.

## What the first administrator should do

1. **Record each Guro's Duty** (Destinado / Katuwang) on the Teachers pages, and set each teacher's **Current Destination** with its Duty. Duty-based generation reads these and will never infer them. A dako may hold one Destinado and one Katuwang at the same time.
2. **Encode weekly availability** for the weeks it intends to generate — every master-ACTIVE teacher must have a record per week. The dashboard matrix's readiness marks show at a glance which weeks are ready.
3. **Configure email if password recovery is expected.** SMTP keys go in `%LOCALAPPDATA%\PNK Suguan\.env` (`PNK_SMTP_HOST`, `PNK_SMTP_PORT`, `PNK_SMTP_SECURE`, `PNK_SMTP_USER`, `PNK_SMTP_PASS`, `PNK_SMTP_FROM`, or the single `PNK_SMTP_URL`), then the application must be restarted. **Settings → Email delivery** states whether email is configured and offers an audited test send to your own address; until it is configured, "Forgot password" accepts requests but cannot deliver a code.
4. **Review Settings**, including the backup location, so operator backups have somewhere to land. Settings also carries the **Administrator documentation** link to the Super Admin guide PDF shipped inside the package.
5. **Create the operator accounts** the site needs (Settings → Users), assigning the least role that fits each person — see `USER-ROLE-GUIDE.md`. Teachers, Dako, Users, and Backup/Restore are all reached through the **Settings** group in the sidebar.

Nothing in this release requires an internet connection: the database, the application, the fonts, and the documentation PDFs are all bundled locally.
