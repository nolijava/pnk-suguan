# PNK Suguan 2.0.0 — Installation Guide

1. Obtain `PNK-Suguan-Setup-2.0.0.exe` and its `.json` sidecar.
2. Verify the SHA-256 with `certutil -hashfile "PNK-Suguan-Setup-2.0.0.exe" SHA256` and compare it to `installerSha256` in `PNK-Suguan-Setup-2.0.0.json`.
3. Run the installer. The default program location is `%LOCALAPPDATA%\Programs\PNK Suguan\`.
4. The installer creates Start Menu/Desktop shortcuts and an Apps & Programs entry.
5. Start PNK Suguan and allow the browser to open.
6. On first run, PostgreSQL initializes in `%LOCALAPPDATA%\PNK Suguan\`; migrations apply once and the first-run administrator file is created there.
7. Sign in, rotate the temporary password, then delete `FIRST-RUN-ADMIN-PASSWORD.txt`.

## Upgrade from 1.0.x

This upgrade applies migrations 0008–0012, including the **destructive** removal of dako Purok/Grupo (0009). Before upgrading:

1. **Stop the running application.**
2. **Take a backup** (Settings → Backup, or a manual copy of `%LOCALAPPDATA%\PNK Suguan\` while stopped). For 1.0.x installations there is no in-app backup — use the manual procedure in `DATA-PRESERVATION-AND-BACKUP.md`. This is the only source from which the dropped dako Purok/Grupo values could ever be recovered.
3. Run the verified 2.0.0 installer into the same program location.

The user-data directory is separate and is preserved; the existing database, users, passwords, configuration, assignments, schedules, and history are reused. The launcher applies the new migrations once on startup. Do not delete user data as an upgrade workaround.

## After upgrading

- **Record each Guro's Duty** (Teachers) before using Assign Destinado / Assign Katuwang. Existing teachers have no duty value and the system will not infer one; duty-less teachers simply take no part in duty-based generation until a duty is set. Auto-generate and manual encoding work regardless.
- **Weekly availability is now a prerequisite.** Weeks whose availability was never encoded will refuse to generate. Use the readiness marks on the dashboard matrix, or the "Fix availability" guide, to find and fill the gaps (Fill blanks as AVAILABLE does this in one confirmed action).
- Dako records no longer carry Purok/Grupo; that field remains on teachers, where it always had meaning.

Normal uninstall removes program files and shortcuts but preserves `%LOCALAPPDATA%\PNK Suguan\`. Reinstalling reuses that data.
