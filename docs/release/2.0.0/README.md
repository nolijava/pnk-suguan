# PNK Suguan System — Release 2.0.0

PNK Suguan 2.0.0 is a self-contained, per-user Windows release for local operation, and the second major construction phase of the product.

| Item | Value |
|---|---|
| Release | PNK Suguan 2.0.0 |
| Application version | 2.0.0 |
| Build ID | Recorded in `BUILD-MANIFEST.json` |
| Installer | `PNK-Suguan-Setup-2.0.0.exe` |
| Installer SHA-256 | `49b4c961ab6afd17dc9282c341a9da7ece36257dc2fa2eb874518ba45406ff46` (also in `PNK-Suguan-Setup-2.0.0.json`) |
| Program files | `%LOCALAPPDATA%\Programs\PNK Suguan\` |
| User data | `%LOCALAPPDATA%\PNK Suguan\` |

The package bundles Node.js 22, PostgreSQL 16, the production application, migrations, PDF assets, and fonts. The application and database bind to loopback. User data is separate from program files and normal uninstall preserves it.

Verify the installer hash before running it. This release has no automatic updater, no cloud sync, and no telemetry. Unlike 1.0.x it **does** include an operator-facing Backup / Restore feature (Settings), with scheduled backups remaining out of scope; manual data-preservation guidance is still provided separately.

## What 2.0.0 adds over 1.0.x

- **Weekly Availability prerequisite (generation gate).** Auto-generate, Assign Destinado, Assign Katuwang, and Manual encoding all refuse to run until the selected week's availability is encoded for every master-ACTIVE teacher. The rule is enforced server-side and audited; the Annual matrix shows each week's readiness in advance, and a blocked week deep-links into a "Fix availability" guide.
- **Mga Magtuturo sa Klase.** A separate teaching-assignment category (4 SUGO seats + 2 RESERBA seats per week) with its own page, generation continuity rules, and month view — stored in its own table so the normal Suguan engine and reports are untouched.
- **Guro Duty + duty-based generation.** Each Guro record carries a Duty (Destinado or Katuwang); two new generation modes fill the week from those rosters with deterministic fair rotation. Hand-placed (MANUAL/OVERRIDE) cells survive regeneration.
- **Operator Backup / Restore.** pg_dump-based backups with integrity validation and audit, default or operator-chosen destination, and restore gated behind a typed confirmation.
- **Teacher celebration notices.** Individual birthday notices and grouped oath-anniversary notices.
- **Database restructure.** Migrations 0008–0012 (priority dakos, removal of dako Purok/Grupo, the Magtuturo table, celebration notices, Guro Duty). All upgrades must apply them; see the Installation Guide.

## Guides in this set

| Document | Purpose |
|---|---|
| `INDEX.md` | Entry point — start here when reading the Markdown set |
| `RELEASE-NOTES.md` | What changed, versions, limitations |
| `INSTALLATION-GUIDE.md` | Install, verify, upgrade from 1.0.x |
| `FIRST-RUN-ADMINISTRATOR-GUIDE.md` | First login and password rotation |
| `OPERATIONS-GUIDE.md` | Day-to-day workflows, including the availability gate and the new modules |
| `USER-ROLE-GUIDE.md` | What each role may do |
| `TROUBLESHOOTING.md` | Common problems and remedies |
| `DATA-PRESERVATION-AND-BACKUP.md` | Program/data separation and backup practice |
