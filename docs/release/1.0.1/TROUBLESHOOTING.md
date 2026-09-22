# PNK Suguan 1.0.1 — Troubleshooting

Start here when something does not work. Every instruction below either checks state or restarts
something. **No step in this guide weakens a security control, and no step asks you to delete your data
as a first move.**

Two headings are worth knowing before you read further:

- **Logs:** `%LOCALAPPDATA%\PNK Suguan\logs\` — `launcher.log`, `app.log`, `app.err.log`,
  `postgres.log`, `pg_ctl.log`. When you ask for help, these files answer most questions.
- **The launcher's `status` command** tells you what is actually running without changing anything:

  ```
  "%LOCALAPPDATA%\Programs\PNK Suguan\Start PNK Suguan.cmd" status
  ```

  It reports the data folder, whether the application is running, the URL, the database cluster state,
  the installed build, and whether the application's health check is ready.

---

## 1. The installer does not start, or closes immediately

1. **Verify the file first.** Follow `VERIFY-RELEASE.txt`. A file that fails verification is not the
   validated release — obtain it again rather than troubleshooting it.
2. **Run it from a Command Prompt** so that any message stays on screen:
   open Command Prompt, then run the installer by its full path. The installer is a console program and
   prints its progress (and any error) as text.
3. **Check your rights.** The default location is per-user and needs no administrator rights. If you
   installed to a different folder (for example under `C:\Program Files`), re-run from an **elevated**
   Command Prompt.
4. **Check antivirus / endpoint protection policy.** Unsigned installers are sometimes blocked outright by
   organisational policy. If the file is blocked, that is a policy decision — contact
   «internal IT contact» (placeholder — replace with your organisation's support channel) rather than
   working around it.

---

## 2. Windows SmartScreen warning: "Windows protected your PC"

**This is expected for release 1.0.1, because the installer is not code-signed.**

What to do:

1. Confirm the **SHA-256** of the file matches the published value (`VERIFY-RELEASE.txt`). This is what
   tells you the file is the genuine release.
2. Only if it matches, proceed with the standard Windows flow for an unsigned application
   (**More info** → check that the app name is the installer you expected → **Run anyway**).
3. If the hash does **not** match, stop; do not proceed, and re-obtain the file.

What **not** to do: do not disable Microsoft Defender or SmartScreen, do not add broad exclusions, and do
not lower your organisation's security settings to install this. If your policy does not allow running
unsigned software, that is the correct answer — ask your IT team, or obtain a signed build.

The warning proves nothing about the file's contents; the **hash** is the trust anchor for this release.

---

## 3. "PNK Suguan is currently running, so its files cannot be replaced"

The installer refuses to overwrite a running installation, so that an upgrade cannot leave you with a
half-old, half-new program folder.

**Fix:** stop PNK Suguan, then run the installer again.

- Close the launcher window, **or** run `Stop PNK Suguan.cmd` from the program folder.
- Confirm it stopped: `status` should report the application as `stopped`.
- Your database and settings are not affected — neither by this check nor by upgrading.

If the launcher window is not visible but the application still responds, a previous session may still be
supervising it. Run `Stop PNK Suguan.cmd` again, then check `status`.

---

## 4. Starting PNK Suguan twice

You cannot accidentally run two copies.

Starting it again while it is running reports:

```
already running (pid 12345)
http://127.0.0.1:3210
```

and simply opens the browser on the existing instance. Simultaneous double-clicks are serialized by an
exclusive lock, so two launches never create two database clusters.

If a launch reports `another launch is still starting up — wait a moment and run this again`, a previous
start is still coming up. Wait a few seconds and start it again — this is normal and safe.

---

## 5. The browser did not open

The application is very likely running fine; only the automatic browser launch failed.

1. Read the URL from the launcher window (the last banner line shows it, for example
   `http://127.0.0.1:3210`).
2. Open it manually in any browser on **this** machine.
3. If you want to suppress the automatic launch deliberately, start with `--no-browser` — useful for
   automation.

Note that the address is `127.0.0.1`, which means "this computer". Reaching it from another machine is
not possible by design: both the application and the database bind loopback only.

---

## 6. The page does not load, or the application reports "not ready"

1. Run `status` and read the **health** line.
   - `health  ready` — the application and database are both answering.
   - `health  not ready` — the application is serving but the database is unreachable.
2. If health is not ready, look at `%LOCALAPPDATA%\PNK Suguan\logs\postgres.log` and `app.err.log`. Since
   this is a single-machine installation, a failed connection nearly always means PostgreSQL is not
   running.
3. Restart cleanly: `Stop PNK Suguan.cmd`, wait a few seconds, then start from the **PNK Suguan**
   shortcut. The launcher starts PostgreSQL, waits until it accepts connections, applies pending
   migrations, then starts the application and waits for its health check before opening the browser.
4. If the launcher reports `the application did not become ready`, it will name the log file to read
   (`app.err.log`). That file contains the actual cause.

You can also check the health endpoint directly in a browser or a command prompt:

```
curl http://127.0.0.1:3210/api/health
```

`{"status":"ready","ready":true,"db":true,...}` means both halves are up. A `503` with
`"status":"degraded"` means the application is up but the database is not reachable. This endpoint is
unauthenticated by design because the launcher uses it before anyone signs in — it reports only
readiness and never exposes credentials, data or version information.

---

## 7. Port conflict: the application is not on 3210

The application prefers **3210** and the database prefers **55432**. If a preferred port is occupied, the
launcher scans upward for a free one and **remembers the choice** in
`%LOCALAPPDATA%\PNK Suguan\config.json`, so later launches reuse it rather than changing port each time.

The launcher says so explicitly (`preferred app port busy — using 3211`), and `status` always shows the
URL actually in use. **Trust the printed URL**, not the assumption that it is 3210.

If every candidate port is busy, the launcher reports:

```
no free port in 3210-3259. Free a port or edit config.json in the data folder.
```

Fix it by closing whatever is holding the ports (usually another development tool), or by editing
`config.json` and restarting. Note that the persisted choice is deliberate — if the application
"moved" to a new port after you stopped using something, that is because the fallback was remembered;
`config.json` is the single place that records it.

---

## 8. Login problems

### "Invalid credentials"

The message is deliberately uniform: it does **not** tell you whether the address exists, so it should
never be read as "that user does not exist". Check the address and the password.

### Repeated failures, then everything is refused for a while

Failed sign-ins are backed off **exponentially per account and per client address**: 0.5 s, 1 s, 2 s, 4 s
and so on, capped at **15 seconds**. A successful sign-in clears the backoff. The state is in-memory, so
**restarting the application clears it** (stop, then start).

What this means in practice:

- After a few failed attempts, a *correct* password can be refused until the backoff expires. Wait it
  out, or restart the application to clear it.
- **Do not weaken or disable throttling to make testing easier.** It is a security control, and this
  release does not provide a switch for it.

### I forgot the password

Use **Forgot password** to receive a one-time code by e-mail. **This requires SMTP to be configured** by
an operator in `%LOCALAPPDATA%\PNK Suguan\.env` (`PNK_SMTP_*`); without it, no mail can be sent and this
path cannot complete. **SMTP settings are operator-provided information** — they are not part of the
release.

When SMTP is unavailable, an operator resets the account directly using the provisioning tools that ship
with the source (not with the installer). There is deliberately no insecure offline reset in the
application.

Codes are single-use, expire, and lock after five attempts.

### "I am being forced to change my password"

That is intentional. The first-run administrator and any account given a temporary password are flagged
as *must change password*, and the change is enforced server-side: you cannot reach any other page until
it is done. The new password needs at least 10 characters with an uppercase letter, a lowercase letter, a
digit and a symbol.

Changing a password **revokes every session** for that account, including the current one — you will be
asked to sign in again with the new password. That is the expected, intended behaviour.

### I am signed in but a page is denied

That is role-based access control working as designed, not a fault. Check your role in
`USER-ROLE-GUIDE.pdf` — for example, only Administrator and Super Admin may finalize or publish a week,
and only Super Admin may correct a PUBLISHED week. Hiding a button is never the security boundary; the
server refuses the action regardless of how it is requested.

---

## 9. "The installation looks incomplete or was moved incorrectly"

The launcher verifies that the payload is complete before starting, and lists exactly what it could not
find (for example the bundled Node runtime, the PostgreSQL binaries, `app/server.js`, the migrations
folder, or the launcher's tool scripts).

Causes and fixes:

- **The program folder was moved or partially deleted.** Reinstall the package. Your data folder is not
  affected.
- **Only the data folder moved.** Set the `PNK_DATA_DIR` environment variable to the new data folder
  location and start again.

Do not repair this by copying files between the program and data folders — they must stay separate.

---

## 10. The database cluster will not start

`status` shows the database cluster as `uninitialized` when the cluster is missing, `stopped` when it
exists but is not running, and `running` when it is up.

- **`stopped` and it will not start:** read `logs\postgres.log` and `logs\pg_ctl.log`. On a first run, a
  failure here is usually a permissions problem on the data folder, or a locked port (section 7).
- **`uninitialized` unexpectedly:** the cluster directory (`pgdata\`) is missing or unreadable. If you
  have a backup of the data folder, restore it (including `.env`). Do **not** delete the folder to "start
  fresh" unless you have accepted the loss of the records — a fresh cluster means an empty system.
- A failed startup does not destroy existing data: the launcher stops PostgreSQL rather than orphaning it,
  and the data directory is left intact so a retry resumes.

---

## 11. Stopping and restarting

- **Stop:** close the launcher window, or run `Stop PNK Suguan.cmd`.
- **Restart:** start from the **PNK Suguan** shortcut.

Shutdown is ordered: the application is stopped first, then PostgreSQL is shut down gracefully (a fast
shutdown), leaving the data directory clean. If the application does not exit within its grace window it
is terminated, while PostgreSQL still shuts down gracefully — a documented asymmetry of this release that
does not affect data integrity.

If `stop` reports `application was not running`, there was nothing to stop and any stale pid file is
cleaned up; the command still shuts down PostgreSQL if it is up. A pid belonging to some other program is
never killed: the launcher verifies a process against its command line before signalling it.

---

## 12. Reinstalling

1. Uninstall (or just run the installer again to upgrade in place).
2. Run the installer.
3. Start PNK Suguan.

Your data folder is reused: no database reinitialisation, no re-application of migrations, no
re-provisioning of the administrator, no regeneration of secrets, and your existing login keeps working.

If the installation starts fresh instead — for example you are asked to change a first-run password — then
the data folder was not found. Check that `%LOCALAPPDATA%\PNK Suguan\` still exists and still contains
`pgdata\` and `.env`. Do not start "fresh" if you were expecting existing records: stop, restore your
data folder from backup, then start again.

---

## 13. Upgrading

1. **Stop PNK Suguan** (the installer refuses a running installation — section 3).
2. Verify the new installer's hash.
3. Run the new installer, then start PNK Suguan.

Existing data, users, password hashes, configuration and secrets are preserved; existing migrations are
not re-run and new ones apply once. Downgrades are not supported.

One known cosmetic side effect: an in-place upgrade can leave stale static files from the previous build
under `app\.next\static\<old-build-hash>\` in the **program** folder. **Future maintenance item — not
addressed in R1.** No functional, data or security impact has been demonstrated. Do not hand-edit the
program folder to remove them.

---

## 14. Uninstalling, and keeping your data

Uninstall removes the program, the shortcuts and the Apps & Programs entry, and **keeps**
`%LOCALAPPDATA%\PNK Suguan\`.

- **Exporting, archiving or moving the installation:** copy the whole data folder first (see
  `DATA-PRESERVATION-AND-BACKUP.pdf`, section 6).
- **"I uninstalled and want my data gone":** nothing in the uninstaller deletes it, by design. If you
  genuinely want it removed, back it up if there is any doubt, then delete
  `%LOCALAPPDATA%\PNK Suguan\` **manually**. This is permanent.
- **The uninstaller left files behind:** this can happen if a file was locked at the time (typically
  because the application was still running). Stop the application and delete the remaining program
  folder. Your data folder is separate and is not affected.

---

## 15. Reporting a problem

Include:

- what you did, and what you expected to happen;
- the exact message on screen;
- the output of `status`;
- the relevant log files from `%LOCALAPPDATA%\PNK Suguan\logs\`;
- the installer version (**1.0.1**), the application version (**0.1.0**) and the build ID
  (**`20260920043134-c1f595`**);
- the installer's verified SHA-256, if the problem is about the installer itself.

Send it to **«internal IT contact»** (placeholder — replace with your organisation's support channel).

**Never send** the contents of `%LOCALAPPDATA%\PNK Suguan\.env`, a database dump, or any password.
