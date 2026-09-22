# PNK Suguan 1.0.2 — First-Run Administrator Guide

On a genuine first run, the bundled PostgreSQL cluster is initialized in `%LOCALAPPDATA%\\PNK Suguan\\`, the application database is created, migrations are applied once, and the initial Administrator account is provisioned.

The generated one-time password is written to:

```text
%LOCALAPPDATA%\\PNK Suguan\\FIRST-RUN-ADMIN-PASSWORD.txt
```

This document contains no password. Read the file locally, sign in, and complete the forced password rotation. Password changes revoke existing sessions. Delete the one-time password file immediately after successful rotation.

The first account is Administrator, not SUPER_ADMIN. SUPER_ADMIN remains an exceptional, separately controlled emergency capability. Never copy `.env`, credentials, password files, or session material into the program folder or distribution package.
