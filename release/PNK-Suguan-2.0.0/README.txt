PNK SUGUAN SYSTEM — RELEASE 2.0.0

Installer: PNK-Suguan-Setup-2.0.0.exe
Application version: 2.0.0
Build ID: 20260924160110-bdba2b
Installer SHA-256: 49b4c961ab6afd17dc9282c341a9da7ece36257dc2fa2eb874518ba45406ff46
Bundled Node.js: v22.23.2
Bundled PostgreSQL: 16.x (see BUILD-MANIFEST.json)

Program files: %LOCALAPPDATA%\Programs\PNK Suguan\
User data:     %LOCALAPPDATA%\PNK Suguan\

Verify the SHA-256 before running the installer (VERIFY-RELEASE.txt). This is a per-user, loopback-only Windows application. User data is separate and normal uninstall preserves it. No credentials, QA samples, or runtime data are included.

WHAT 2.0.0 ADDS

- Weekly Availability prerequisite: generation (any method) is blocked until the selected week's availability is encoded for every master-ACTIVE teacher. Enforced server-side, audited, and surfaced in advance by readiness marks on the dashboard matrix and a "Fix availability" guide.
- Mga Magtuturo sa Klase: a separate teaching-assignment category (4 SUGO + 2 RESERBA seats per week) with continuity-based generation and a month view.
- Guro Duty (Destinado / Katuwang) with two duty-based generation modes and deterministic fair rotation.
- Operator Backup / Restore (Settings): validated pg_dump archives, default or chosen destination, typed-confirmation restore. Scheduled backups remain out of scope.
- Teacher celebration notices: individual birthdays and grouped oath anniversaries.
- Migrations 0008-0012, including the DESTRUCTIVE removal of dako Purok/Grupo (0009). Take a backup before upgrading from 1.0.x — see INSTALLATION-GUIDE.md.

UPGRADING FROM 1.0.x

1. Stop the running application.
2. Take a backup (manual full-folder copy for 1.0.x — see DATA-PRESERVATION-AND-BACKUP.md).
3. Run the verified 2.0.0 installer into the same program location.
The user-data directory is preserved; the launcher applies the new migrations once on startup. Record each Guro's Duty after upgrading — duty-based generation never infers it.

GUIDES IN THIS PACKAGE

INSTALLATION-GUIDE.pdf            install, verify, upgrade
FIRST-RUN-ADMINISTRATOR-GUIDE.pdf first login and password rotation
OPERATIONS-GUIDE.pdf              the weekly cycle and every module
USER-ROLE-GUIDE.pdf               what each role may do
DATA-PRESERVATION-AND-BACKUP.pdf  protecting your data
TROUBLESHOOTING.pdf               common problems and remedies

No automatic updater, cloud sync, or telemetry is provided. The in-app Backup/Restore feature is operator-triggered only.
