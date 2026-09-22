# PNK Suguan 1.0.1 — Release Package Checklist

Use this before handing the package to anyone. It is the gate that says "this folder is the validated
release, unmodified, with nothing leaked into it".

**The artifact being distributed:**

| | |
| --- | --- |
| Installer | `PNK-Suguan-Setup-1.0.1.exe` |
| Size | 91,223,040 bytes (87.0 MiB) |
| SHA-256 | `b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093` |
| Installer version | 1.0.1 |
| Application version | 0.1.0 |
| Build ID | `20260920043134-c1f595` |
| Bundled Node.js | v22.23.2 |
| Bundled PostgreSQL | 16.14 |

---

## 1. Artifact integrity

- [ ] `PNK-Suguan-Setup-1.0.1.exe` computes to
      `b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093`
      (`certutil -hashfile "PNK-Suguan-Setup-1.0.1.exe" SHA256`).
- [ ] The value matches `PNK-Suguan-Setup-1.0.1.sha256` in this folder.
- [ ] The value matches the published release record.
- [ ] `MANIFEST.sha256` verifies without any `FAILED` line (`sha256sum -c MANIFEST.sha256`).
- [ ] The manifest lists every file that is present, and no file is present that it does not list
      (the manifest itself is the sole, expected exception).
- [ ] The **installer has not been rebuilt, patched, re-packed or re-hashed** for this distribution.

---

## 2. Package contents

- [ ] `PNK-Suguan-Setup-1.0.1.exe`
- [ ] `PNK-Suguan-Setup-1.0.1.sha256`
- [ ] `MANIFEST.sha256`
- [ ] `README.txt`
- [ ] `VERIFY-RELEASE.txt`
- [ ] `RELEASE-NOTES.txt`
- [ ] `CHECKLIST.md`
- [ ] `INSTALLATION-GUIDE.pdf` + `.md`
- [ ] `FIRST-RUN-ADMINISTRATOR-GUIDE.pdf` + `.md`
- [ ] `USER-ROLE-GUIDE.pdf` + `.md`
- [ ] `OPERATIONS-GUIDE.pdf` + `.md`
- [ ] `DATA-PRESERVATION-AND-BACKUP.pdf` + `.md`
- [ ] `TROUBLESHOOTING.pdf` + `.md`
- [ ] No file has been added, renamed or removed relative to this list.

---

## 3. Nothing sensitive inside

Confirm the package contains **none** of the following — by file name **and** by file content:

- [ ] `.env` files, or any environment file
- [ ] Credentials, password files, `FIRST-RUN-ADMIN-PASSWORD` copies
- [ ] Session cookies or session tokens
- [ ] A PostgreSQL data directory (`pgdata`) or any live database
- [ ] Development or test clusters (`pnk-dev`, `pnk-test`), `.pg` trees, `backups` trees
- [ ] `super-admin-credentials`, `super-cookies`, or any QA credential dump
- [ ] Private keys, certificates, API keys, SMTP passwords, the OTP pepper, the Super Admin unlock secret
- [ ] `.freebuff` (assistant/tooling workspace), `.git` or any source-control metadata
- [ ] QA evidence, QA fixtures, test databases, development logs
- [ ] Symlinks or reparse points
- [ ] Unexpected executables beyond the installer itself
- [ ] The real SUPER_ADMIN credentials, in any form

- [ ] The documentation contains **no live credential** — no password, no token, no secret value. Any
      password described in a guide is described as a *procedure*, never as a value.
- [ ] Support and contact references use the placeholder **«internal IT contact»** (or your organisation's
      real channel), and no invented e-mail address, phone number, website or portal appears.

---

## 4. Documentation is accurate

- [ ] Every claim in the guides is traceable to the validated release or to its source.
- [ ] Installer options quoted are the real ones: `/dir=`, `/quiet`, `/launch`, `/nolaunch`, `/uninstall`.
- [ ] Paths are correct: program `%LOCALAPPDATA%\Programs\PNK Suguan\`, data `%LOCALAPPDATA%\PNK Suguan\`.
- [ ] Ports are correct: application prefers 3210, database prefers 55432, both loopback, fallback
      persisted in `config.json`.
- [ ] The role matrix matches the application's own permission definitions exactly — no role is described
      as broader than it is, and Scheduler/Encoder is not described as able to finalize, publish, or
      correct a published week.
- [ ] The language rule is described correctly: an ENGLISH dako accepts ENGLISH teachers only;
      `LANGUAGE_MISMATCH` is non-overridable by every role including Administrator and Super Admin.
- [ ] No automated backup, restore, telemetry, auto-update or cloud feature is described — because none
      exists in this release.
- [ ] `data\backups` is described as currently unused, not as a backup mechanism.
- [ ] Gaps are marked as "Not specified by the validated release." or "Operator-provided information
      required." rather than filled with assumptions.
- [ ] The stale-static-asset upgrade effect is recorded as **"Future maintenance item — not addressed in
      R1"**, not as fixed.

---

## 5. Operational readiness

- [ ] A support/contact channel has been substituted for the placeholder.
- [ ] The distribution channel is decided, and recipients know how to obtain the package.
- [ ] Recipients know to verify the hash **before** running the installer.
- [ ] Someone is named as responsible for **manual backups**, with a target and a frequency.
- [ ] Users have been assigned the smallest role that lets them work.
- [ ] A recipient has been told to **delete `FIRST-RUN-ADMIN-PASSWORD.txt`** after the first sign-in.
- [ ] Anyone who needs **Forgot password** has SMTP configured, or knows the operator-assisted route.
- [ ] The documented limitations in `RELEASE-NOTES.txt` have been read and accepted.

---

## 6. Freeze confirmation

- [ ] The validated installer was not modified, rebuilt or replaced to produce this package.
- [ ] The package was assembled by **copying** the validated artifact; the copy's hash was verified
      against the original after copying.
- [ ] No application source, database schema, migration, RBAC rule, authentication behaviour,
      language rule, scheduling rule, installer or launcher was changed.
- [ ] No commit, no push and no branch was involved.
- [ ] No L8 / subsequent phase was started.

---

**Checklist result:** the package is suitable for distribution when every box above is ticked.

If any box cannot be ticked, do not distribute: record what failed and stop.
