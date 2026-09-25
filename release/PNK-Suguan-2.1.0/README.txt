PNK SUGUAN SYSTEM — RELEASE 2.1.0

Installer: PNK-Suguan-Setup-2.1.0.exe
Application version: 2.1.0
Build ID: 20260925100758-ac26a7
Installer SHA-256: 78ca817c00c8d0161f1344a512226912e06df019d6d983fc70d6f4d193f0f0f1
Installer size: 88.4 MB (92,687,360 bytes)
Bundled Node.js: v22.23.2
Bundled PostgreSQL: 16.14 (see BUILD-MANIFEST.json)
Database migration applied by this release: 0013_destination_duty.sql (additive)

Program files: %LOCALAPPDATA%\Programs\PNK Suguan\
User data:     %LOCALAPPDATA%\PNK Suguan\

Verify the SHA-256 before running the installer (VERIFY-RELEASE.txt). This is a per-user, loopback-only Windows application. User data is separate and normal uninstall preserves it. No credentials, QA samples, or runtime data are included.

WHAT 2.1.0 ADDS (NEW UPDATE BATCH #1-#11)

- Navigation restructured into five top-level entries: Dashboard, Schedule, Reports, Settings, Audit. Schedule discloses Weekly Schedule, Availability, Magtuturo and Historical Backfill; Settings discloses Teachers, Dako, Users and Backup/Restore. No route moved and no permission was removed.
- Every report can be generated as a PDF — source summary, annual, weekly, per-teacher history, per-dako history, celebrations — each carrying the filters the page is showing. Read-only: an export changes no data and writes no audit rows.
- Teacher Masterlist report with a field-selection step: choose exactly the columns to export (Age is always computed from Birthday, never stored), re-validated server-side.
- Destination Duty is recorded on the destination relationship: the teacher page shows the duty of the current destination and of every past period, the Change Current Destination dialog takes a Duty, and a dako shows its current Destinado and Katuwang.
- Dashboard Dako row names render at 8pt, matching the teacher names in the same row.
- Global table typography standardised (10px headers, 12.5px data, 10px badges, 11px in-table buttons) with the dashboard matrix keeping its own scale.
- Dashboard micro-badges now carry seven distinct hues in both themes; two pairs that were previously identical are distinguishable.
- Password recovery by email can deliver its code once SMTP is configured in the data folder's .env; Settings reports the state truthfully and offers an audited delivery test. Until then it fails closed, exactly as before.
- Super Admin reference manual (PDF) ships inside the package and is linked from Settings.

UPGRADING FROM 2.0.0

1. Stop the running application (Start Menu > PNK Suguan > Stop, or the Stop button in the launcher window).
2. Take a backup (Settings > Backup/Restore > Create backup, or a full copy of %LOCALAPPDATA%\PNK Suguan\ while stopped).
3. Run the verified 2.1.0 installer into the same program location and start the application.

Migration 0013 is additive: it adds destination_history.duty, widens the per-dako rule to one active period per (dako, duty), and labels only those open periods whose teacher already records that duty and that destination. Prompted by fact only — nothing is inferred, closed periods are never rewritten, and no column, table or row is dropped. Teachers, dako, assignments, weeks, availability, users and audit history are preserved.

Upgrading from 1.0.x additionally applies 0008-0012, including the DESTRUCTIVE removal of dako Purok/Grupo (0009). Stop the application and take a full-folder backup first — see INSTALLATION-GUIDE.md and DATA-PRESERVATION-AND-BACKUP.md.

AFTER UPGRADING

- Review Settings > Email delivery if password recovery by email is expected: SMTP keys live in %LOCALAPPDATA%\PNK Suguan\.env and the application must be restarted after editing them.
- Weekly availability remains a prerequisite for generation (introduced in 2.0.0).
- Teachers without a recorded Duty take no part in Assign Destinado / Assign Katuwang until one is set; the system never infers it.

GUIDES IN THIS PACKAGE

README.md / README.txt            this overview and the change list
INDEX.md                          the documentation set at a glance
RELEASE-NOTES.md                  full New Update Batch #1-#11 change list
INSTALLATION-GUIDE.pdf            install, verify, upgrade
FIRST-RUN-ADMINISTRATOR-GUIDE.pdf first login, rotation, first-run setup
OPERATIONS-GUIDE.pdf              the weekly cycle, reports/PDF, destination duty, email, backups
USER-ROLE-GUIDE.pdf               what each role may do, and where each page lives
SUPER-ADMIN-GUIDE.pdf             SUPER_ADMIN capability, published-week correction, recovery
DATA-PRESERVATION-AND-BACKUP.pdf  protecting your data, including before an upgrade
TROUBLESHOOTING.pdf               common problems and remedies
VERIFY-RELEASE.txt                how to verify the installer hash and the whole package
MANIFEST.sha256                   SHA-256 of every file in this package

No automatic updater, cloud sync, or telemetry is provided. The in-app Backup/Restore feature is operator-triggered only; there is no scheduled backup service.
