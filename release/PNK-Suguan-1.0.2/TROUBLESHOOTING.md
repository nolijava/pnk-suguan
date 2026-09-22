# PNK Suguan 1.0.2 — Troubleshooting

- **SmartScreen warning:** this release is not code-signed. Verify the SHA-256 through a trusted channel before deciding whether to run it; do not disable security controls globally.
- **Installer refuses to replace files:** stop PNK Suguan and retry. This protects upgrades from mixed payloads.
- **Browser does not open:** use the loopback URL printed by the launcher or run the Start shortcut again.
- **Login problem:** use the first-run file only for the initial login, complete password rotation, and delete the file afterward. Do not disclose passwords.
- **Port conflict:** the launcher selects and remembers an available loopback port in user data.
- **Restart:** use `Start PNK Suguan.cmd` and `Stop PNK Suguan.cmd`; do not kill unrelated PostgreSQL processes.
- **Upgrade/reinstall:** stop the app first; keep `%LOCALAPPDATA%\\PNK Suguan\\`; do not delete user data as a first-line remedy.
- **Uninstall:** normal uninstall preserves user data. Delete it manually only when permanent data removal is intended and after any manual preservation procedure.

No automatic updater, cloud service, telemetry, or automated backup/restore mechanism exists in this release.
