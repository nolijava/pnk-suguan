# PNK Suguan 2.0.0 — Troubleshooting

- **SmartScreen warning:** this release is not code-signed. Verify the SHA-256 through a trusted channel before deciding whether to run it; do not disable security controls globally.
- **Installer refuses to replace files:** stop PNK Suguan and retry. This protects upgrades from mixed payloads.
- **Browser does not open:** use the loopback URL printed by the launcher or run the Start shortcut again.
- **Login problem:** use the first-run file only for the initial login, complete password rotation, and delete the file afterward. Do not disclose passwords.
- **Port conflict:** the launcher selects and remembers an available loopback port in user data.
- **Restart:** use `Start PNK Suguan.cmd` and `Stop PNK Suguan.cmd`; do not kill unrelated PostgreSQL processes.
- **Upgrade/reinstall:** stop the app first; keep `%LOCALAPPDATA%\PNK Suguan\`; do not delete user data as a first-line remedy.
- **Uninstall:** normal uninstall preserves user data. Delete it manually only when permanent data removal is intended and after any manual preservation procedure.

## New in 2.0.0

- **"Weekly Availability Required" when generating:** the selected week's availability is incomplete. Open the action in the notice (or click the blocked week's ring mark on the dashboard) to reach the Fix availability guide, then either **Fill N as AVAILABLE** or encode each highlighted teacher. The gate is server-side — retrying from another path will not bypass it.
- **Duty-based generation produces nothing on a dako:** that dako's teachers have no recorded **Duty** (or none eligible this week). Record duties on the Teachers pages; the system never infers them. Auto-generate and hand encoding remain available.
- **Assign Destinado / Assign Katuwang changed last week's pattern:** these modes replace only generation-produced rows; hand-placed (MANUAL/OVERRIDE) cells survive. Re-running with the other mode re-plans from that mode's roster.
- **Dako lost its Purok/Grupo field:** deliberate (migration 0009). The field remains on teachers.
- **Backup fails or reports failure:** check the destination exists and is writable (custom locations are chosen through the folder dialog and must already exist), and check the audit log — every failure is recorded and never reported as success.
- **Restore confirmation rejects the file name:** the typed confirmation must match the archive name exactly, including extension. Verify the file exists and is a validated backup.
- **Celebration notifications missing:** birthday notices dedupe per teacher and year; oath-anniversary notices group teachers sharing a date into one notice. Stored oath dates are never modified.

No automatic updater, cloud service, telemetry, or scheduled backup mechanism exists in this release. The in-app Backup/Restore feature is operator-triggered only.
