# PNK Suguan 2.0.0 — Documentation Set

Guides for PNK Suguan 2.0.0, a self-contained, per-user Windows release for local operation.

| Document | Read it when you need to… |
|---|---|
| [README.md](README.md) | See what this release is and what it adds over 1.0.x |
| [RELEASE-NOTES.md](RELEASE-NOTES.md) | Review the change list, versions, and known limitations |
| [INSTALLATION-GUIDE.md](INSTALLATION-GUIDE.md) | Install fresh, or **upgrade from 1.0.x** (migrations 0008–0012) |
| [FIRST-RUN-ADMINISTRATOR-GUIDE.md](FIRST-RUN-ADMINISTRATOR-GUIDE.md) | Perform the first login and password rotation |
| [OPERATIONS-GUIDE.md](OPERATIONS-GUIDE.md) | Run the weekly cycle: availability gate, generation modes, Magtuturo, backups |
| [USER-ROLE-GUIDE.md](USER-ROLE-GUIDE.md) | Check what each role may do |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnose install, upgrade, generation, or backup problems |
| [DATA-PRESERVATION-AND-BACKUP.md](DATA-PRESERVATION-AND-BACKUP.md) | Protect data, including before an upgrade from 1.0.x |

## Upgrading from 1.0.x — read before installing

This release applies migrations 0008–0012, including the **destructive** removal of dako Purok/Grupo (0009). Stop the application and take a backup first; the steps are in the Installation Guide, and the reason is in the Data Preservation guide.

## The one workflow change operators will feel

**Generation is now blocked until the selected week's availability is encoded for every master-ACTIVE teacher** — for Auto-generate, Assign Destinado, Assign Katuwang, and the Manual entry point alike. The dashboard matrix shows each week's readiness in advance (filled dot = ready, ring = blocked), and a blocked week links into a "Fix availability" guide that fills the gaps in one confirmed action. Section 3 of the Operations Guide covers it.
