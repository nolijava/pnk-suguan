# PNK Suguan 2.1.0 — Data Preservation and Manual Backup Guidance

Program files and user data are separate:

```text
Program: %LOCALAPPDATA%\Programs\PNK Suguan\
Data:    %LOCALAPPDATA%\PNK Suguan\
```

Normal uninstall removes the program payload but preserves the data directory. Reinstall and upgrade are designed to reuse it. Do not delete the data folder when troubleshooting an installation or upgrade.

## The in-app Backup / Restore feature

**Settings → Backup/Restore** creates a validated `pg_dump` archive of the database — to the default backup folder or an operator-chosen location — and **Restore** replays a chosen archive behind a typed confirmation. Every attempt, successful or failed, is audited, and a failed backup is never reported as success. Restore always writes a safety backup first.

The feature backs up the **database**. It does not cover the rest of the user-data folder (configuration, the remembered port, the email `.env`, logs), it is operator-triggered — there is **no scheduled backup service** — and it cannot protect a 1.0.x installation being upgraded, because the backup has to be taken before the new version runs.

## What 2.1.0 changes

Migration `0013_destination_duty.sql` is **additive**:

- it adds the nullable `destination_history.duty` column;
- it widens the per-dako uniqueness rule from one active period per dako to one active period per (dako, duty), so a dako may hold one Destinado and one Katuwang at once;
- it labels the **open** period of a teacher whose recorded duty matches their current destination, and nothing else — closed periods are never rewritten and nothing is inferred.

No column, table, or row is dropped, no assignment or history record is rewritten, and a period with no recorded duty keeps reading "—". Existing destination history, teachers, dako, weeks, availability, assignments, assignment history, users, and audit records are preserved.

## Manual full-data procedure

For full-folder protection, or before an upgrade from 1.0.x:

1. Stop PNK Suguan with `Stop PNK Suguan.cmd` (the database must not be writing).
2. Copy the entire data directory somewhere protected, e.g. `robocopy "%LOCALAPPDATA%\PNK Suguan" "D:\Backups\PNK Suguan %DATE%" /E`.
3. Verify the copy contains the PostgreSQL cluster before trusting it.
4. Restart with `Start PNK Suguan.cmd`.

Never distribute the data directory with the installer, and never paste `.env`, credential files, or dumps into the program folder. The data folder's `.env` holds this machine's live credentials (database password, OTP pepper, Super Admin secret, and any SMTP password) — it must never be copied into the package, attached to a report, or committed anywhere. Before upgrading from 1.0.x specifically, the full-folder copy is the only source from which the dropped dako Purok/Grupo values (migration 0009) could ever be recovered.
