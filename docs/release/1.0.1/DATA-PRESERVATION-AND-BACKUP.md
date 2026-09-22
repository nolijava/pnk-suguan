# PNK Suguan 1.0.1 — Data Preservation and Backup

Your records live in **one folder**, separate from the program. This guide explains what is in it, how
uninstall and upgrade treat it, how to verify it survived, and how to make a **manual** backup.

> **Backups in PNK Suguan 1.0.1 are MANUAL.**
> The application does **not** schedule backups, does not run a backup service, and does not back up in
> the background. There is no "restore" button in the interface. Everything in this guide is something
> **you** run, or ask your IT support to run.

---

## 1. The two folders

| | Program | Data |
| --- | --- | --- |
| Location | `%LOCALAPPDATA%\Programs\PNK Suguan\` | `%LOCALAPPDATA%\PNK Suguan\` |
| Contains | Launcher, bundled Node.js, bundled PostgreSQL binaries, the application, migrations, fonts, PDF assets | Database cluster, configuration, generated secrets, logs, runtime files |
| Changed by | Installing or upgrading | Normal use |
| Survives uninstall | **No** — removed | **Yes** — always kept |
| Back this up? | No — it is replaceable by reinstalling | **Yes — this is your data** |

The separation is enforced by design: the application **never** writes your database inside the program
folder, and the installer **refuses** to install into the data folder (or to remove it).

In full:

```
C:\Users\<you>\AppData\Local\Programs\PNK Suguan\      program  (replaceable)
C:\Users\<you>\AppData\Local\PNK Suguan\               data     (your records)
```

---

## 2. What is inside the data folder

| Item | What it is | Needed to recover? |
| --- | --- | --- |
| `pgdata\` | **The PostgreSQL database cluster — your users, teachers, dako, assignments, schedules, destinations, history, audit trail** | **Yes — this is the data** |
| `.env` | Generated secrets for this machine: database password, Super Admin unlock secret, OTP pepper, and the administrator e-mail value | **Yes** — without it the database password no longer matches the cluster |
| `config.json` | The chosen application and database ports, remembered between launches | Recommended |
| `logs\` | `launcher.log`, `app.log`, `app.err.log`, `postgres.log`, `pg_ctl.log` — diagnostic output | No, but useful when reporting a problem |
| `run\` | Runtime files: `app.pid`, `launcher.pid`, `launcher.lock` | No — recreated as needed |
| `backups\` | **An empty folder. Nothing in the application writes to it.** See section 5 | No |
| `FIRST-RUN-ADMIN-PASSWORD.txt` | The one-time first-run password. Should be **deleted** after first sign-in | No — and it should not exist |

**`pgdata` and `.env` belong together.** A copy of the cluster without the matching `.env` cannot be
started, because the database password stored in the cluster's authentication configuration was generated
into that file. Always back up both, or copy the whole folder.

---

## 3. Uninstall and reinstall

**Uninstall removes the program; it keeps the data.**

Removed: program files (including bundled Node.js and PostgreSQL), Start Menu and Desktop shortcuts, and
the Apps & Programs registration.

Kept: the entire data folder. The uninstaller prints where it is and states that reinstalling will reuse
it. It also **refuses** to delete the data folder even if it is pointed at it, and it deliberately offers
no "delete my data too" switch.

**Reinstall reuses it.** After reinstalling, the existing data folder is detected and used as-is:

- the database is **not** reinitialised;
- migrations are **not** re-applied;
- no administrator is re-provisioned — you will **not** get a new `FIRST-RUN-ADMIN-PASSWORD.txt`;
- generated secrets are **not** regenerated, so existing passwords keep working;
- your existing login and all records remain.

This was verified: install → first run → create data → uninstall → confirm program gone and data present
→ reinstall → start → data reused, no re-init, no admin reprovisioning, login still working.

**A normal uninstall is therefore safe to reinstall later, with no data loss.**

---

## 4. Upgrade

An in-place upgrade (running a newer installer over the old one) **does not touch the data folder**.
Users, password hashes, configuration, secrets, business records and audit history are preserved; the
PostgreSQL cluster is not reinitialised; existing migrations are not re-run; new migrations are applied
exactly once.

The installer refuses to run while PNK Suguan is still running. That refusal exists so an upgrade can
never leave you with a half-old, half-new installation — stop the application first. See
`INSTALLATION-GUIDE.pdf`, section 10.

**Downgrades are not supported**, and no automatic downgrade is performed.

---

## 5. About the `backups` folder

`%LOCALAPPDATA%\PNK Suguan\backups\` is created by the launcher on first run and is currently **unused**:
**no component of PNK Suguan 1.0.1 writes anything into it**, and nothing reads from it.

- Do **not** rely on it. It is not a backup mechanism and it is empty by default.
- You may use it for your own manual dump files if you like — the location is convenient and it is inside
  the data folder, so it is easy to find, and easy to include in your own backup of that folder.
- Because no automated backup exists, having a copy of your data folder elsewhere remains **your**
  responsibility.

---

## 6. MANUAL BACKUP

Choose either method. Method A is the simplest and is what most users should do.

### Method A — copy the whole data folder (recommended)

**Step 1. Stop PNK Suguan.** Copying a live database cluster is not safe. Close the launcher window, or
run `Stop PNK Suguan.cmd` from the program folder. Confirm it is stopped:

```
"%LOCALAPPDATA%\Programs\PNK Suguan\Start PNK Suguan.cmd" status
```

The application should report `stopped`, and the database cluster should not be `running`.

**Step 2. Copy the folder.** In File Explorer, copy

```
%LOCALAPPDATA%\PNK Suguan
```

to your backup location — an external drive, a network share your organisation trusts, or a managed
backup target. A dated folder name such as `PNK-Suguan-data-2026-09-20` keeps versions straight.

**Step 3. Start PNK Suguan again** with the shortcut.

**To restore:** stop the application, replace the whole `%LOCALAPPDATA%\PNK Suguan\` folder with your
copy (including `.env`), and start again. Because the copy contains both `pgdata` and `.env`, the cluster
and its password stay consistent.

### Method B — logical database dump with the bundled `pg_dump`

PNK Suguan ships PostgreSQL's own tools, so an independent dump is possible without installing anything.
The dump is a single file that can be restored into a fresh cluster.

**Step 1. Find the port and database name.** The application uses database `pnk`, user `postgres`, on
`127.0.0.1`. The port is in `config.json` in the data folder (default **55432**).

**Step 2. Run the dump** (adjust the port if your `config.json` says otherwise). `pg_dump` will **prompt
for the password**, which you can read from `PNK_DB_PASSWORD` in `%LOCALAPPDATA%\PNK Suguan\.env`;
letting it prompt avoids putting the secret into your command history:

```
"%LOCALAPPDATA%\Programs\PNK Suguan\postgres\bin\pg_dump.exe" -h 127.0.0.1 -p 55432 -U postgres -Fc -f "D:\Backups\pnk-2026-09-20.dump" pnk
```

**Step 3. Store the dump securely**, together with a copy of `.env` (needed to restore the cluster's
password consistency). Treat both as confidential.

**To restore** into a running installation, use the bundled `pg_restore`:

```
"%LOCALAPPDATA%\Programs\PNK Suguan\postgres\bin\pg_restore.exe" -h 127.0.0.1 -p 55432 -U postgres -d pnk --clean --if-exists "D:\Backups\pnk-2026-09-20.dump"
```

Restoring **replaces** the current contents of the database, so take a fresh copy of the data folder
first if there is any doubt.

> **Practical note.** Method B captures the database. Method A captures the database *and* the secrets and
> configuration that make this installation work as installed. For disaster recovery of a whole machine,
> Method A is the more complete answer.

---

## 7. Verifying that your data is intact

Quick checks you can run at any time:

1. **The folders exist.** Both `%LOCALAPPDATA%\PNK Suguan\pgdata\` and
   `%LOCALAPPDATA%\PNK Suguan\.env` are present.
2. **The application reports it is holding a cluster.** The launcher's `status` shows a database cluster
   state of `running` (or `stopped` when the app is down — **not** `uninitialized`, which would mean the
   cluster is missing).
3. **Your data is there in the interface** — open Teachers and Dako, and a week you have worked on, and
   confirm the records are present.
4. **A restore drill is the only real proof** of a backup. Copy your backup to a scratch machine (or a
   scratch folder via `PNK_DATA_DIR`, below), start the application against it and confirm the records
   appear. Do this before you need it.

### Testing a backup without disturbing the live installation

The launcher honours an environment variable, `PNK_DATA_DIR`, which points it at a different data folder.
Pointing it at a **copy** of your backup is a safe way to prove the backup is good without touching the
working installation: run `Start PNK Suguan.cmd` with `PNK_DATA_DIR` set to the copied folder.

---

## 8. What destroys data

| Action | Effect |
| --- | --- |
| Running the uninstaller | Program removed, **data kept** |
| Reinstalling or upgrading | **No effect** on data |
| Deleting `%LOCALAPPDATA%\PNK Suguan\` by hand | **Permanent loss of every record** |
| Deleting `pgdata\` or `.env` alone | **Breaks the installation** — the cluster and its password no longer match |
| Copying `pgdata` while the application is running | Corrupt, unusable backup |
| Moving `pgdata` into the program folder | Not supported — the application never looks for data there |
| Restoring a dump over a live database | Replaces current contents with the dump's contents |

**Before deleting anything, take a copy of the whole data folder.** There is no undelete, and no
automated backup to fall back on.

---

## 9. Recovering an installation on a new PC

1. Install PNK Suguan on the new PC (a fresh installation with no first run needed).
2. **Stop** it before it creates records — or, if it already ran once, stop it and note that its own
   fresh data folder will be replaced.
3. Copy your backed-up `%LOCALAPPDATA%\PNK Suguan\` folder over the new machine's data folder,
   **including `.env`**.
4. Start PNK Suguan. It mounts the restored cluster, applies any migrations the newer program requires,
   and your records, users and passwords are as they were at backup time.

Keep the backed-up `.env` with the backed-up cluster. Without it, the cluster's password will not match.

---

**Reminder:** no automated backup exists in this release. Decide now who copies this folder, where to,
and how often — and write it down. «internal IT contact» (placeholder — replace with your
organisation's support channel) can advise on a suitable target if you do not have one.
