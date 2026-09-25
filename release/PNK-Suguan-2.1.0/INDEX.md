# PNK Suguan 2.1.0 — Documentation Set

Guides for PNK Suguan 2.1.0, a self-contained, per-user Windows release for local operation. This release implements **New Update Batch #1–#11**.

| Document | Read it when you need to… |
|---|---|
| [README.md](README.md) | See what this release is and what it adds over 2.0.0 |
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | Review the batch change list, versions, and known limitations |
| [INSTALLATION-GUIDE.md](INSTALLATION-GUIDE.md) | Install fresh, or **upgrade** (0013 from 2.0.0; 0008–0013 from 1.0.x) |
| [FIRST-RUN-ADMINISTRATOR-GUIDE.md](FIRST-RUN-ADMINISTRATOR-GUIDE.md) | Perform the first login, rotation, and first-run setup |
| [OPERATIONS-GUIDE.md](OPERATIONS-GUIDE.md) | Run the weekly cycle: availability gate, generation modes, Magtuturo, reports and PDFs, backups, email |
| [USER-ROLE-GUIDE.md](USER-ROLE-GUIDE.md) | Check what each role may do and where each page lives |
| [SUPER-ADMIN-GUIDE.md](SUPER-ADMIN-GUIDE.md) | Use the SUPER_ADMIN capability: published-week correction, provisioning, recovery |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnose install, upgrade, generation, report, or email-delivery problems |
| [DATA-PRESERVATION-AND-BACKUP.md](DATA-PRESERVATION-AND-BACKUP.md) | Protect data, including before an upgrade |

## Upgrading? Read this first

**Stop the application, take a backup, then install.** From 2.0.0 the upgrade applies one additive migration (`0013_destination_duty.sql`); from 1.0.x it also applies 0008–0012, which include the deliberate removal of dako Purok/Grupo (0009). The steps are in the Installation Guide and the reasoning is in the Data Preservation guide.

## The three things operators will notice immediately

1. **The sidebar has five entries** — Dashboard, Schedule, Reports, Settings, Audit — with Schedule and Settings opening into their existing pages. No route moved, so old bookmarks and direct URLs still work. (New Update #11)
2. **Every report now has Generate PDF**, and the Teacher Masterlist lets you choose its columns before exporting. (New Updates #4, #5)
3. **The dashboard reads as one consistent column**, with Dako names at 8pt and micro-badges that are finally distinguishable from each other — seven identifiers, seven hues, in both themes. (New Updates #1, #9, #10)

Password recovery by email additionally needs SMTP keys in `%LOCALAPPDATA%\PNK Suguan\.env` and an application restart; **Settings → Email delivery** reports that state truthfully and can send an audited test. (New Update #2)
