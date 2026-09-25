# PNK Suguan 2.1.0 — Installation Guide

1. Obtain `PNK-Suguan-Setup-2.1.0.exe` and its `.json` sidecar.
2. Verify the SHA-256 with `certutil -hashfile "PNK-Suguan-Setup-2.1.0.exe" SHA256` and compare it to `installerSha256` in `PNK-Suguan-Setup-2.1.0.json`.
3. Run the installer. The default program location is `%LOCALAPPDATA%\Programs\PNK Suguan\`.
4. The installer creates Start Menu/Desktop shortcuts and an Apps & Programs entry.
5. Start PNK Suguan and allow the browser to open.
6. On first run, PostgreSQL initializes in `%LOCALAPPDATA%\PNK Suguan\`; migrations apply once and the first-run administrator file is created there.
7. Sign in, rotate the temporary password, then delete `FIRST-RUN-ADMIN-PASSWORD.txt`.

## Upgrade

**Stop the application before installing.** The installer replaces program files and will refuse to do so while they are in use; stop it from the Start Menu (`Stop PNK Suguan`) or the launcher window, then run the installer into the same program location.

### From 2.0.0

1. **Stop the application.**
2. **Take a backup** — Settings → Backup/Restore → Create backup, or copy `%LOCALAPPDATA%\PNK Suguan\` while stopped (see `DATA-PRESERVATION-AND-BACKUP.md`).
3. Run the verified 2.1.0 installer.
4. Start the application. Migration `0013_destination_duty.sql` applies once.

Migration 0013 is additive: it adds `destination_history.duty`, widens the per-dako rule to one active period per (dako, duty), and labels only the open periods whose teacher already records that duty and that destination. Closed periods are never rewritten, no column or row is dropped, and a period with no recorded duty keeps reading "—". Existing teachers, dako, assignments, weeks, availability, users, and audit history are untouched.

### From 1.0.x

This path also applies migrations 0008–0012, which include the **destructive** removal of dako Purok/Grupo (0009). Before upgrading:

1. **Stop the running application.**
2. **Take a full-folder backup** — for 1.0.x there is no in-app backup, so use the manual procedure in `DATA-PRESERVATION-AND-BACKUP.md`. This copy is the only source from which the dropped dako Purok/Grupo values could ever be recovered.
3. Run the verified 2.1.0 installer into the same program location.

### Which installations need a duty recorded

2.0.0 introduced Guro Duty and 2.1.0 records it on the destination relationship. When upgrading from 1.0.x, existing teachers have no duty value and the system will not infer one: duty-less teachers simply take no part in Assign Destinado / Assign Katuwang until a duty is set. Auto-generate and hand encoding work regardless. When upgrading from 2.0.0, duties already recorded on teachers are used to label their **open** destination period.

### After upgrading

- Review **Settings → Email delivery** if password recovery by email is expected: SMTP keys live in `%LOCALAPPDATA%\PNK Suguan\.env`, and the application must be restarted after they are edited. Until they are set, Forgot Password accepts requests but cannot deliver a code.
- **Weekly availability remains a prerequisite** for generation (introduced in 2.0.0). The dashboard matrix's readiness marks show which weeks are ready.
- The navigation is grouped into **Dashboard, Schedule, Reports, Settings, Audit** (New Update #11). No route changed, so bookmarks and direct URLs still open the same pages.

The user-data directory is separate and is preserved; the existing database, users, passwords, configuration, assignments, schedules, and history are reused. The launcher applies the new migrations once on startup. Do not delete user data as an upgrade workaround.

Normal uninstall removes program files and shortcuts but preserves `%LOCALAPPDATA%\PNK Suguan\`. Reinstalling reuses that data.
