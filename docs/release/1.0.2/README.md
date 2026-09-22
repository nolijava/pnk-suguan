# PNK Suguan System — Release 1.0.2

PNK Suguan 1.0.2 is a self-contained, per-user Windows release for local operation.

| Item | Value |
|---|---|
| Release | PNK Suguan 1.0.2 |
| Application version | 0.1.1 |
| Build ID | Recorded in `BUILD-MANIFEST.json` |
| Installer | `PNK-Suguan-Setup-1.0.2.exe` |
| Installer SHA-256 | Recorded in `PNK-Suguan-Setup-1.0.2.sha256` |
| Program files | `%LOCALAPPDATA%\\Programs\\PNK Suguan\\` |
| User data | `%LOCALAPPDATA%\\PNK Suguan\\` |

The package bundles Node.js, PostgreSQL, the production application, migrations, PDF assets, and fonts. The application and database bind to loopback. User data is separate from program files and normal uninstall preserves it.

Verify the installer hash before running it. This release has no automatic updater, no cloud sync, no telemetry, and no automated backup/restore feature. Manual data-preservation guidance is provided separately.

The release includes the accepted Patotoo teacher-assignment PDF pages appended after the existing Weekly Suguan page. The approved renderer and Page 1 behavior are unchanged.
