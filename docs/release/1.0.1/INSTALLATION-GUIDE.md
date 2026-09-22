# PNK Suguan 1.0.1 — Installation Guide

This guide installs PNK Suguan on a single Windows PC. It assumes you have the release package folder
described in `README.txt`.

**Nothing here requires an internet connection, and nothing here requires a developer environment.**

---

## 1. Before you start

### Requirements

| Requirement | Detail |
| --- | --- |
| Windows | 64-bit Windows with **.NET Framework 4.0 or newer** (in-box on Windows 10 and 11) |
| Rights | A normal user account. The default location is per-user and needs **no administrator rights** |
| Disk space | ≈ 243 MiB for the program; the database cluster is created at first run and grows with your data |
| Network | **Not required**, at any point |

Validated on: **Windows 11 (64-bit), build 10.0.26200, .NET Framework 4.8**. Other Windows editions and
versions have not been tested — that is a documented limitation of 1.0.1. If you need a guarantee for a
different edition, test it before deployment.

### Where things go

| Purpose | Location | Removed by uninstall? |
| --- | --- | --- |
| Program files | `%LOCALAPPDATA%\Programs\PNK Suguan\` | **Yes** |
| User data (database, config, secrets, logs) | `%LOCALAPPDATA%\PNK Suguan\` | **No — always kept** |

In full, that is normally:

```
C:\Users\<you>\AppData\Local\Programs\PNK Suguan\
C:\Users\<you>\AppData\Local\PNK Suguan\
```

Keep this distinction in mind for the rest of the guide: **the program folder is disposable and
replaceable; the data folder is your records.**

---

## 2. Obtain the installer

Take `PNK-Suguan-Setup-1.0.1.exe` from the release package, together with
`PNK-Suguan-Setup-1.0.1.sha256`.

**Distribution channel: operator-provided information required.** The validated release does not specify
how the package is delivered to end users (shared drive, removable media, internal file share, e-mail).
Follow your organisation's channel.

---

## 3. Verify the SHA-256 **before** running it

```
certutil -hashfile "PNK-Suguan-Setup-1.0.1.exe" SHA256
```

Expected:

```
b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093
```

If the value differs, **do not install** — re-obtain the file and verify again.
Full instructions, including PowerShell alternatives and how to verify every file in the package, are in
`VERIFY-RELEASE.txt`.

You may also see a Windows SmartScreen warning on first run because this release is not code-signed.
That is expected and documented; `TROUBLESHOOTING.txt` explains what the warning means and how to
proceed safely.

---

## 4. Run the installer

Double-click **`PNK-Suguan-Setup-1.0.1.exe`**. It runs in a console window and reports each step it
takes.

With no options it will:

1. extract the program payload into `%LOCALAPPDATA%\Programs\PNK Suguan\` (about 243 MiB);
2. create a **Start Menu** shortcut and a **Desktop** shortcut, both named **PNK Suguan**;
3. register the installation in Windows **Apps & Programs**;
4. install its own uninstaller as `Uninstall PNK Suguan.exe` in the program folder;
5. start PNK Suguan for the first time.

A successful run ends with something like:

```
  PNK Suguan 1.0.1 installed.

  Program : C:\Users\<you>\AppData\Local\Programs\PNK Suguan
  Data    : C:\Users\<you>\AppData\Local\PNK Suguan
  Start   : Start Menu > PNK Suguan
```

### Choosing the installation location

The default is `%LOCALAPPDATA%\Programs\PNK Suguan`. To install elsewhere, pass the folder explicitly:

```
PNK-Suguan-Setup-1.0.1.exe /dir="D:\Apps\PNK Suguan"
```

To a location that needs administrator rights, run the installer from an **elevated** Command Prompt.

### Installer options

| Option | Effect |
| --- | --- |
| `/dir=<path>` | Install into `<path>` instead of the default per-user location |
| `/quiet` | Suppress the progress output (install only; no automatic start) |
| `/launch` | Start PNK Suguan after installing |
| `/nolaunch` | Do **not** start PNK Suguan after installing |
| `/uninstall`, `/u` | Run as the uninstaller instead of the installer |

Installing from an elevated prompt without options installs to the same **per-user** path for the
elevated account — pass `/dir=` explicitly if you intend a machine-wide location.

### Installations the installer deliberately refuses

The installer protects your data and your installation. It will stop with an explanation if:

- the target folder is **inside** your data folder
  (`Refusing to install INSIDE the user data directory…`) — program and data must stay separate;
- the target folder already contains a `pgdata` directory
  (`The target directory looks like a PostgreSQL data directory…`) — it will not overwrite a database;
- **PNK Suguan is currently running** (`PNK Suguan is currently running, so its files cannot be
  replaced…`). This check exists so an upgrade can never leave you with a half-old, half-new
  installation. Stop the application first (see section 9), then run the installer again. **Your data is
  not affected by this or by upgrading.**

If you see `No permission to replace files in …`, re-run the installer with sufficient rights for that
location.

---

## 5. Verify the installation

**Apps & Programs** (Settings → Apps → Installed apps) should list:

| Field | Value |
| --- | --- |
| Name | PNK Suguan |
| Version | 1.0.1 |
| Publisher | PNK Suguan System |

The registration is per-user (under `HKEY_CURRENT_USER`) rather than machine-wide — a documented
limitation of this release.

**Shortcuts:** Start Menu → *PNK Suguan*, and a Desktop icon of the same name. Both point at
`Start PNK Suguan.cmd` in the program folder, and both use the program folder as the working directory.
Selecting the shortcut with no arguments starts the application.

**Installation record:** the program folder contains `INSTALL-INFO.json`, which records the installer
version, the payload application version, the build ID, the install time, and both directory paths. It
contains **no secrets**.

---

## 6. First start

On the very first start the launcher performs the whole bring-up in a fixed order and prints each step:

1. creates the local PostgreSQL cluster inside your **data** folder (this is the slow step, one time only);
2. starts PostgreSQL on `127.0.0.1` and waits until it accepts connections;
3. creates the application database;
4. applies the database migrations (**once**);
5. provisions the initial administrator account and writes its one-time password to
   `FIRST-RUN-ADMIN-PASSWORD.txt` in your data folder;
6. starts the application server on `127.0.0.1`;
7. waits for the application's health check to report ready;
8. opens your default browser.

The launcher window must stay open: it supervises the application and shuts everything down when you
close it.

### The URL, and what to do if the port is busy

The application prefers **`http://127.0.0.1:3210`** and the database prefers port **55432**. If a
preferred port is already in use, the launcher takes the next free one (scanning up to 50 ports) and
**remembers the choice** in `config.json` in your data folder, so later launches reuse it instead of
drifting to a different port each time.

The launcher prints the exact URL it opened, and the `status` command shows it again at any time
(section 9). Trust the printed URL over the assumption that it is always 3210.

### Browser did not open?

The application is still running. Open your browser manually and go to the URL printed in the launcher
window. (You can also suppress the automatic browser launch deliberately with `--no-browser`.) See
`TROUBLESHOOTING.txt` if the page does not load.

---

## 7. Complete the administrator setup

1. Open `%LOCALAPPDATA%\PNK Suguan\` and read **`FIRST-RUN-ADMIN-PASSWORD.txt`**. It contains the
   default administrator e-mail address and a one-time generated password.
2. Sign in at the application's login page with those credentials.
3. You will be required to **change the password** before anything else can be used. The new password
   must be at least 10 characters and contain an uppercase letter, a lowercase letter, a digit and a
   symbol.
4. After the change, **delete `FIRST-RUN-ADMIN-PASSWORD.txt`**.

Changing the password revokes every existing session, so you will be asked to sign in again with the new
password. That is expected.

Full detail — including how the password is generated, why it is never packaged, and how the
SUPER_ADMIN role differs from the first administrator — is in `FIRST-RUN-ADMINISTRATOR-GUIDE.pdf`.

---

## 8. Check that it works

At minimum, confirm:

- the login page loads, and signing in reaches the dashboard;
- the **Teachers** and **Dako** pages open;
- a schedule week opens and the Weekly Suguan PDF can be produced;
- close the launcher window, start PNK Suguan from the Start Menu again, and confirm you are still
  signed in / can sign in and that your data is still there.

That last step confirms both halves of the layout: the program restarts, and the data persist.

---

## 9. Starting, stopping and checking status

Use the **PNK Suguan** shortcut to start. Two helper scripts in the program folder do the same thing:

| Script | Purpose |
| --- | --- |
| `Start PNK Suguan.cmd` | Start the application (and the database) |
| `Stop PNK Suguan.cmd` | Stop the application and the PostgreSQL cluster gracefully |

The launcher itself accepts a command and two options:

| Command / option | Effect |
| --- | --- |
| `start` (default) | Bring up the database and application, then open the browser |
| `stop` | Stop the application and this installation's PostgreSQL, gracefully |
| `status` | Report what is running — changes nothing |
| `--no-browser` | Do not open the browser automatically |
| `--foreground` | Keep the console attached and stop everything on exit (this is the default; there is no detached mode) |

`status` reports the data folder, whether the application is running, the application URL, the database
cluster state, the installed build, and the health result — for example:

```
application      running (pid 12345)
app url          http://127.0.0.1:3210
database cluster running on port 55432
build            0.1.0 (20260920043134-c1f595)
health           ready
```

Two guarantees worth knowing:

- Starting PNK Suguan when it is **already running** does not create a second copy. The launcher detects
  the running instance, reports `already running`, and simply opens the browser.
- Closing the launcher window, or running `stop`, shuts the stack down in order: the application first,
  then PostgreSQL with a fast graceful shutdown. Your data directory is left clean, so the next start is
  fast and safe.

---

## 10. Upgrading an existing installation

1. **Stop PNK Suguan** (close the launcher window, or run `Stop PNK Suguan.cmd`). The installer refuses
   to run otherwise — that refusal protects you from a half-replaced installation.
2. Verify the new installer's hash.
3. Run the new installer. It installs over the previous version in the same folder.
4. Start PNK Suguan as usual.

Your data folder is **not** touched by an upgrade. Users, password hashes, configuration, generated
secrets, teachers, dako, assignments, schedules and audit history are preserved; the PostgreSQL cluster
is **not** reinitialised, existing migrations are not re-applied, and any new migrations are applied
exactly once.

This was tested from 1.0.0 to 1.0.1 on an installation holding real data. **Downgrades are not supported
and no automatic downgrade is performed.**

One known cosmetic side effect of an in-place upgrade is that stale static files from the previous
build can remain under `app\.next\static\<old-build-hash>\` in the program folder. This is recorded as a
**future maintenance item — not addressed in R1**; no functional, data or security impact has been
demonstrated.

---

## 11. Uninstalling, and reinstalling later

**Settings → Apps → Installed apps → PNK Suguan → Uninstall**, or run
`"Uninstall PNK Suguan.exe" /uninstall` from the program folder. Add `/quiet` for no output.

Uninstall removes:

- the program files, including the bundled Node.js and PostgreSQL binaries;
- the Start Menu and Desktop shortcuts;
- the Apps & Programs registration.

Uninstall **keeps** your entire data folder — database, configuration, secrets, logs and the history of
your records — and prints its location when it finishes:

```
  YOUR DATA HAS BEEN KEPT:
    C:\Users\<you>\AppData\Local\PNK Suguan
  Reinstalling will reuse this database, configuration and history.
  To remove it as well, delete that folder manually.
```

The uninstaller **refuses** to delete the data folder even if it is pointed at it, and it deliberately
does not offer an automatic "delete my data too" option. If you genuinely want the data gone, delete the
folder manually — see `DATA-PRESERVATION-AND-BACKUP.pdf` first.

**Reinstalling:** run the installer again, then start PNK Suguan. The existing data folder is detected
and reused: the database is not reinitialised, migrations are not re-applied, no administrator is
re-provisioned, generated secrets are not regenerated, and your existing login still works. This was
tested (install → first run → data → uninstall → reinstall).

---

## 12. If the installation fails

| Symptom | Likely cause and action |
| --- | --- |
| `PNK Suguan is currently running…` | Stop the application, then re-run the installer |
| `No permission to replace files…` | Re-run from an elevated Command Prompt |
| `The target directory looks like a PostgreSQL data directory…` | You pointed `/dir=` at a data folder; choose a program folder |
| `Refusing to install INSIDE the user data directory…` | Same cause; program and data must be separate |
| `The installation looks incomplete or was moved incorrectly` | The launcher found payload files missing — reinstall the package |
| `another launch is still starting up — wait a moment…` | A previous launch is still coming up; wait and start again |

Never resolve an installation problem by deleting your data folder. See `TROUBLESHOOTING.pdf`.
