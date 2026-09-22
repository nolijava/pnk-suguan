# PNK Suguan System — Release 1.0.1

This folder is the **distribution package README**. It ships alongside the Windows installer and tells
you what you have received, what to verify, and where the software and your data will live.

---

## 1. What this package is

An **offline, local Windows application**. It installs a complete, self-contained copy of PNK Suguan —
bundled Node.js, bundled PostgreSQL, and the application — onto one PC. Nothing is installed from the
internet, nothing runs on a remote server, and the application and its database accept connections from
**this machine only** (`127.0.0.1`).

| Item | Value |
| --- | --- |
| Product | PNK Suguan System |
| Release | **PNK Suguan 1.0.1** |
| Installer file | `PNK-Suguan-Setup-1.0.1.exe` |
| Installer size | 91,223,040 bytes (87.0 MiB) |
| Installer SHA-256 | `b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093` |
| Application version | 0.1.0 |
| Build ID | `20260920043134-c1f595` |
| Bundled Node.js | v22.23.2 |
| Bundled PostgreSQL | 16.14 |

### Version identity — read this before quoting a version number

Three labels appear in this release, and they mean different things:

- **1.0.1** — the *installer / package* version. This is the version of the thing you are installing now,
  and it is the version shown in Windows **Apps & Programs**. Use this one when you refer to the release.
- **0.1.0** — the *application* version reported by the payload itself (`BUILD-MANIFEST.json`, and the
  launcher's `status` command).
- **`20260920043134-c1f595`** — the *build ID* of the packaged payload.

The validated payload carries **no source-control revision identifier**, because it was not built from a
tagged commit. The only authoritative anchor for this exact artifact is therefore its **SHA-256 hash**
(above) — not a version string. Verify the hash before installing, and treat the hash as the identity of
the release.

---

## 2. What you must do first: verify the package

Do not install until the hash matches. Follow **`VERIFY-RELEASE.txt`** (or `VERIFY-RELEASE.md`), which
walks through `certutil` and PowerShell verification using a standard Windows PC.

`MANIFEST.sha256` additionally lists the SHA-256 of **every file in this package**, so you can confirm
that no file was altered in transit. See section 5 for an important note about that manifest.

---

## 3. Package contents

```
PNK-Suguan-1.0.1/
├── PNK-Suguan-Setup-1.0.1.exe            the installer
├── PNK-Suguan-Setup-1.0.1.sha256         expected hash of the installer
├── MANIFEST.sha256                       SHA-256 of every file in this package
├── VERIFY-RELEASE.txt / .md              how to verify the hash
├── README.txt / .md                      this document
├── RELEASE-NOTES.txt / .md               what the release contains
├── CHECKLIST.md                          pre-distribution checklist
├── INSTALLATION-GUIDE.pdf / .md          install it
├── FIRST-RUN-ADMINISTRATOR-GUIDE.pdf / .md   the first administrator account
├── USER-ROLE-GUIDE.pdf / .md             who may do what
├── OPERATIONS-GUIDE.pdf / .md            day-to-day use
├── DATA-PRESERVATION-AND-BACKUP.pdf / .md    your data, and manual backups
└── TROUBLESHOOTING.pdf / .md             when something goes wrong
```

The `.pdf` files are the reading copies; the matching `.md` files are the editable sources and contain
exactly the same text.

---

## 4. Where things will be installed

| Purpose | Location | Notes |
| --- | --- | --- |
| **Program files** | `%LOCALAPPDATA%\Programs\PNK Suguan\` | Replaceable. Removed by uninstall. |
| **User data** | `%LOCALAPPDATA%\PNK Suguan\` | Your database, configuration and history. **Kept by uninstall.** |

This separation is deliberate and is the single most important thing to understand about this
installation: **your data never lives inside the program folder**, so the program can be upgraded,
repaired or replaced without touching your records.

Typical locations in full:

```
C:\Users\<you>\AppData\Local\Programs\PNK Suguan\      program
C:\Users\<you>\AppData\Local\PNK Suguan\               data
```

Installation is **per user** and does **not** require an administrator account for the default location.

---

## 5. Known limitation of `MANIFEST.sha256`

`MANIFEST.sha256` lists every file in this package **except itself** — a checksum file cannot contain its
own hash. It is a single-stage manifest, written in the standard `sha256sum` format
(`<hash>␠␠<relative-path>`, forward slashes, sorted) so that standard tools can verify it.

To verify the manifest itself, compare it against a copy obtained from the release publisher through a
separate channel (**operator-provided information required** — the release channel for this build is not
part of the validated artifact).

---

## 6. Getting started

1. Verify the installer hash (`VERIFY-RELEASE.txt`).
2. Run `PNK-Suguan-Setup-1.0.1.exe`. It opens in a console window and installs per-user by default.
3. The installer creates a **Start Menu** shortcut and a **Desktop** shortcut named **PNK Suguan**, then
   starts the application. The first start initialises the local database and can take a little longer.
4. Your browser opens on `http://127.0.0.1:3210` (or the next free port — see below).
5. Sign in with the one-time administrator credentials, which are written to a file inside your data
   folder. See `FIRST-RUN-ADMINISTRATOR-GUIDE.pdf`, then **change the password and delete that file**.

To start or stop the application later, use the **PNK Suguan** shortcut, or the two helper scripts in the
program folder (`Start PNK Suguan.cmd`, `Stop PNK Suguan.cmd`).

### Ports

The application prefers **3210** and the database prefers **55432**, both on `127.0.0.1`. If a preferred
port is already taken, the launcher scans upward for a free one and **remembers the choice** in
`config.json` inside your data folder, so later launches reuse the same ports. The actual URL is always
printed by the launcher and can be read back with the `status` command.

---

## 7. Support and contact

**Support contact: «internal IT contact»** — this is a placeholder. The validated release does not
specify a support address, e-mail, phone number, website or portal. Fill this in with your
organisation's channel before distributing the package.

Likewise, the **distribution channel** (how this folder reaches end users — shared drive, removable
media, internal file share) is **operator-provided information required**; it is not determined by the
release.

---

## 8. What this release is not

- Not a cloud or multi-user server product. It is local and single-machine.
- Not backed by an automated backup system — backups are **manual** (see
  `DATA-PRESERVATION-AND-BACKUP.pdf`).
- Not code-signed. Windows SmartScreen may warn on first run; see `TROUBLESHOOTING.pdf`.
- Not self-updating. Upgrades are performed by running a newer installer.
