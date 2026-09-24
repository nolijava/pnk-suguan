# PNK Suguan 2.0.0 — Data Preservation and Manual Backup Guidance

Program files and user data are separate:

```text
Program: %LOCALAPPDATA%\Programs\PNK Suguan\
Data:    %LOCALAPPDATA%\PNK Suguan\
```

Normal uninstall removes the program payload but preserves the data directory. Reinstall and upgrade are designed to reuse it. Do not delete the data folder when troubleshooting an installation or upgrade.

## What 2.0.0 changes

2.0.0 **includes an operator Backup / Restore feature** (Settings): `pg_dump` archives with integrity validation, a default backup folder or an operator-chosen destination, and a typed-confirmation restore. Use it for routine protection.

The feature backs up the **database**. It does not cover the rest of the user-data folder (configuration, the remembered port, logs), it is operator-triggered — there is **no scheduled backup service** — and it obviously cannot help a 1.0.x installation being upgraded, because the backup must be taken before the new version runs.

## Manual full-data procedure

For full-folder protection, or before an upgrade from 1.0.x:

1. Stop PNK Suguan with `Stop PNK Suguan.cmd` (the database must not be writing).
2. Copy the entire data directory somewhere protected, e.g. `robocopy "%LOCALAPPDATA%\PNK Suguan" "D:\Backups\PNK Suguan %DATE%" /E`.
3. Verify the copy contains the PostgreSQL cluster before trusting it.
4. Restart with `Start PNK Suguan.cmd`.

Never distribute the data directory with the installer, and never paste `.env`, credential files, or dumps into the program folder. Before upgrading from 1.0.x specifically, this backup is the only source from which the dropped dako Purok/Grupo values (migration 0009) could ever be recovered.
