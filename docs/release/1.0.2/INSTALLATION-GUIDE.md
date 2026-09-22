# PNK Suguan 1.0.2 — Installation Guide

1. Obtain `PNK-Suguan-Setup-1.0.2.exe` and its `.sha256` file.
2. Verify the SHA-256 with `certutil -hashfile "PNK-Suguan-Setup-1.0.2.exe" SHA256`.
3. Run the installer. The default program location is `%LOCALAPPDATA%\\Programs\\PNK Suguan\\`.
4. The installer creates Start Menu/Desktop shortcuts and an Apps & Programs entry.
5. Start PNK Suguan and allow the browser to open.
6. On first run, PostgreSQL initializes in `%LOCALAPPDATA%\\PNK Suguan\\`; migrations apply once and the first-run administrator file is created there.
7. Sign in, rotate the temporary password, then delete `FIRST-RUN-ADMIN-PASSWORD.txt`.

## Upgrade from 1.0.1

Stop the running application before installing 1.0.2. Run the verified 1.0.2 installer into the same program location. The user-data directory is separate and is preserved; the existing database, users, passwords, configuration, assignments, schedules, and history are reused. New migrations, if any, are applied by the existing launcher process. Do not delete user data as an upgrade workaround.

Normal uninstall removes program files and shortcuts but preserves `%LOCALAPPDATA%\\PNK Suguan\\`. Reinstalling reuses that data.
