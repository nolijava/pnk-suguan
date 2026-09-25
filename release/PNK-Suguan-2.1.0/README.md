# PNK Suguan System — Release 2.1.0

PNK Suguan 2.1.0 is a self-contained, per-user Windows release for local operation. It is the **New Update Batch #1–#11** release: navigation, reporting, dashboard typography, destination-duty handling and account recovery.

| Item | Value |
|---|---|
| Release | PNK Suguan 2.1.0 |
| Application version | 2.1.0 |
| Build ID | Recorded in `BUILD-MANIFEST.json` |
| Installer | `PNK-Suguan-Setup-2.1.0.exe` |
| Installer size | 88.4 MB (92,687,360 bytes) |
| Installer SHA-256 | `78ca817c00c8d0161f1344a512226912e06df019d6d983fc70d6f4d193f0f0f1` (also in `PNK-Suguan-Setup-2.1.0.json`) |
| Program files | `%LOCALAPPDATA%\Programs\PNK Suguan\` |
| User data | `%LOCALAPPDATA%\PNK Suguan\` |
| Database migration | `0013_destination_duty.sql` (additive) |

The package bundles Node.js 22, PostgreSQL 16, the production application, migrations, PDF assets, and fonts. The application and database bind to loopback. User data is separate from program files, and normal uninstall preserves it. There is no automatic updater, no cloud sync, and no telemetry.

Verify the installer hash before running it.

## What 2.1.0 adds over 2.0.0

- **Navigation restructured into five top-level entries** — Dashboard, Schedule, Reports, Settings, Audit. Schedule and Settings open into their existing pages; no route moved, so existing links still work. (New Update #11)
- **Every report can be generated as a PDF** — source counts, annual per-type, weekly, per-teacher history, per-dako history, celebrations, and the new Teacher Masterlist. Each PDF carries the filters currently applied on the page. (New Updates #4, #5)
- **Teacher Masterlist report** with a field-selection step: tick exactly the Teacher information to export (Age computed from Birthday, never stored). The selection is validated again server-side. (New Update #4)
- **Destination Duty is recorded on the relationship, not on the teacher alone** — Destination History now shows the duty held at each dako, the Change Current Destination dialog takes a Duty, and a dako's profile shows its current Destinado and Katuwang. (New Updates #6, #7, #8)
- **Dashboard Dako names render at 8pt**, matching the teacher names, so a wide matrix reads as one consistent column. (New Update #1)
- **Global table typography standardised** — 10px headers, 12.5px data, 10px badges, 11px in-table buttons — with the dashboard matrix keeping its own dedicated scale. (New Update #9)
- **Dashboard micro-badges carry seven distinct hues** in both themes; previously two pairs were indistinguishable (OVERRIDE ≡ ABSENT and FINALIZED ≡ UPDATED). (New Update #10)
- **Password recovery can now actually deliver its code** — SMTP is configured in this machine's data folder, and Settings reports truthfully whether email is configured, with an audited delivery test. (New Update #2)
- **Super Admin reference manual** — an in-app PDF under Settings, shipped inside the installed package. (New Update #3)

## Upgrading from 2.0.0

One additive migration applies (`0013_destination_duty.sql`): it adds `destination_history.duty`, widens the per-dako uniqueness rule from one active period per dako to one per (dako, duty), and labels only what the data already says. Closed periods are never touched, no column or row is dropped, and a duty-less period simply continues to read "—". Existing destination history, teachers, dako, assignments, weeks, availability, users, and audit records are preserved.

Upgrading from **1.0.x** additionally applies 0008–0012; see the Installation Guide, because that path includes the deliberate removal of dako Purok/Grupo (0009).

## Guides in this set

| Document | Purpose |
|---|---|
| `INSTALLATION-GUIDE.md` | Install fresh or upgrade, including the pre-upgrade backup |
| `FIRST-RUN-ADMINISTRATOR-GUIDE.md` | First login, password rotation, first-run checklist |
| `OPERATIONS-GUIDE.md` | The daily and weekly cycle, reports and PDFs, email configuration |
| `USER-ROLE-GUIDE.md` | What each role may do |
| `SUPER-ADMIN-GUIDE.md` | SUPER_ADMIN capability, published-week correction, provisioning and recovery |
| `DATA-PRESERVATION-AND-BACKUP.md` | Protecting the database and the full data folder |
| `TROUBLESHOOTING.md` | Install, upgrade, report, and email problems |

See `INDEX.md` for the full set. Programme-level notes and the API contract live in the repository's `docs/` directory, which is not part of the installed package.
