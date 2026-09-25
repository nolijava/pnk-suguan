# PNK Suguan 2.1.0 — Troubleshooting

- **SmartScreen warning:** this release is not code-signed. Verify the SHA-256 through a trusted channel before deciding whether to run it; do not disable security controls globally.
- **Installer refuses to replace files:** stop PNK Suguan and retry. This protects upgrades from mixed payloads.
- **Browser does not open:** use the loopback URL printed by the launcher or run the Start shortcut again.
- **Login problem:** use the first-run file only for the initial login, complete password rotation, and delete the file afterward. Do not disclose passwords.
- **Port conflict:** the launcher selects and remembers an available loopback port in user data.
- **Restart:** use `Start PNK Suguan.cmd` and `Stop PNK Suguan.cmd`; do not kill unrelated PostgreSQL processes.
- **Upgrade/reinstall:** stop the app first; keep `%LOCALAPPDATA%\PNK Suguan\`; do not delete user data as a first-line remedy.
- **Uninstall:** normal uninstall preserves user data. Delete it manually only when permanent data removal is intended and after any manual preservation procedure.

## New in 2.1.0

- **"Forgot password" accepts the request but no code arrives.** Almost always the real cause: SMTP is not configured on this machine. Open **Settings → Email delivery** — it states NOT CONFIGURED with the exact key names. Add the `PNK_SMTP_*` keys (or `PNK_SMTP_URL`) to `%LOCALAPPDATA%\PNK Suguan\.env`, **restart the application** — the launcher passes the values to the server at start-up — then use **Send test email to my account** and read the result. A successful test means the mail server accepted the message; if it still does not arrive, check the recipient's spam folder. If the test fails, the host, port, TLS mode, or credentials are wrong; the reason is shown without any secret. Note that the generic reply is deliberate: the request is accepted and answered identically whether or not the address exists, so an unconfigured system never becomes an account-existence oracle.

- **The delivery test button is greyed out.** That is the fail-closed state: with no SMTP configuration there is nothing to send with. The button becomes available once the keys are set and the application restarted. The card is visible only to accounts holding `users.manage`.

- **A report PDF does not download, or downloads a 404/401.** PDF export requires `reports.read` and the same session as the page. Reload the report page and use the **Generate PDF** button on it, so the link carries that page's filters. An unknown field code in a Masterlist export is rejected by the server by design.

- **The Masterlist export is missing a column.** Open **Generate PDF — choose fields…** and tick it. The button exports exactly what is ticked, in catalogue order; "Core fields" restores the default set and "Clear" disables generation until at least one field is selected.

- **A teacher shows "—" for Duty in Destination History.** That period has no recorded duty. Historical periods are never guessed: a period opened before duty recording keeps reading "—" until a destination change records one. Set the Duty through **Change Current Destination** on the teacher page.

- **Two teachers appear to be Destinado on one dako.** That cannot happen for the same slot — the database enforces one active period per (dako, duty). Check the dako's **Current Assignment** card: it lists the current Destinado and Katuwang separately, plus any active teacher whose period predates duty recording (shown as unlabelled).

- **A sidebar group looks empty.** Click the group header to open it; disclosure is never hover-only. If an entry is missing entirely, the signed-in role does not hold its permission (Users needs `users.manage`; Backup/Restore needs `backups.write` or `backups.restore`; Audit is ADMIN-only).

No automatic updater, cloud service, telemetry, or scheduled backup mechanism exists in this release. The in-app Backup/Restore feature is operator-triggered only.
