# PNK Suguan System — Release Notes 1.0.1

**Release:** PNK Suguan 1.0.1
**Application version:** 0.1.0
**Build ID:** `20260920043134-c1f595`
**Installer:** `PNK-Suguan-Setup-1.0.1.exe` (91,223,040 bytes)
**SHA-256:** `b2097e0f6788542705cf211b502c36b03f663b09c133553c9400b5de1897c093`
**Bundled Node.js:** v22.23.2
**Bundled PostgreSQL:** 16.14
**Status:** validated release candidate, frozen

1.0.1 is the **first distributable Windows release** of PNK Suguan. It packages the already-validated
application as a self-contained local installation: the user installs one file and gets a working
system with no internet connection, no server, and no pre-installed developer tooling.

---

## What this release provides

### Installation model

- One installer, per-user, **no administrator rights required** for the default location.
- Program files → `%LOCALAPPDATA%\Programs\PNK Suguan\`
- User data → `%LOCALAPPDATA%\PNK Suguan\`
- Everything the application needs is bundled: Node.js runtime, PostgreSQL server (including `psql`,
  `pg_dump` and `pg_restore`), the compiled application, database migrations, fonts and PDF assets.
- **Nothing is downloaded at install time**, and no component requires a separate installer.

### First run

- The bundled PostgreSQL cluster is created on the machine at first launch (it is not shipped
  pre-populated), the database is created, and the migrations are applied **once**.
- The initial administrator account is provisioned and the one-time password is written to
  `FIRST-RUN-ADMIN-PASSWORD.txt` inside your data folder. **No password is packaged inside the
  installer** — see `FIRST-RUN-ADMINISTRATOR-GUIDE.md`.
- Signing in with that one-time password forces a password change before anything else in the
  application can be used.
- The default browser opens automatically once the application reports itself ready.

### Scheduling lifecycle

- Week lifecycle **DRAFT → FINALIZED → PUBLISHED**.
- Schedule generation is **DRAFT-only**.
- **FINALIZED** weeks are revised through an authorized correction window (the `weeks.unlock`
  permission), with a mandatory reason and an audit record.
- **PUBLISHED** weeks are locked. The only correction path is the **SUPER_ADMIN-only emergency unlock**,
  which is temporary, reason-required, status-preserving, scoped to the holder and fully audited.
- FINALIZED does not drift back to DRAFT; PUBLISHED is not silently editable.

### Assignment rules

- Three independent annual assignment tables: **SUGO → RESERBA → RESERBA II**, three ranked attempts
  per dako, with no deprivation of SUGO or RESERBA by RESERBA II.
- Weekly assignments **never** mutate Current Destination or Destination History; destinations are
  maintained separately.
- Historical Backfill remains **HISTORICAL** and does not alter the current master destination.
- Weekly availability is editable independently of the next week's.
- **Language rule (non-overridable):** an **ENGLISH** dako accepts **ENGLISH** teachers only. A FILIPINO
  dako accepts teachers of either language. A Filipino teacher on an English dako raises
  `LANGUAGE_MISMATCH`, which **no role — including ADMIN and SUPER_ADMIN — can override**; the only
  remedy is correcting the teacher's profile language.

### Reporting and PDF

- A **Weekly Suguan** physical form (PDF) intended for printing, available from the weekly schedule.
- Report views for the week, the annual matrix, teachers and dako, rendered on screen.

### Roles

Four roles are used: **Administrator** (`ADMIN`), **Scheduler/Encoder** (`SCHEDULER`), **Viewer**
(`VIEWER`) and **Super Admin** (`SUPER_ADMIN`). The exact permission set of each is listed in
`USER-ROLE-GUIDE.md` and is enforced **server-side** on every API route; hiding a button is never the
security boundary.

---

## Security characteristics

- **Loopback only.** The application binds `127.0.0.1` and the PostgreSQL cluster binds `127.0.0.1`.
  Neither is reachable from the network.
- **Generated secrets.** The database password, the SUPER_ADMIN unlock secret and the OTP pepper are
  generated with a CSPRNG on first run and stored only in your data folder (`.env`, permissions
  restricted). They are never packaged, logged or printed.
- **Password hashing** uses argon2id.
- **Sessions** use a random 256-bit token stored hashed in the database; the browser cookie
  `pnk_session` is `HttpOnly`, `SameSite=Lax` and `Secure` in production, and expires after **12 hours**.
  Sessions are revoked on logout and on password change, and every request re-checks the session
  against the database — a revoked, expired or deactivated-user session is rejected immediately.
- **Login throttling.** Failed sign-ins are backed off exponentially per account *and* per client
  address (0.5 s, 1 s, 2 s, 4 s … capped at 15 s). The error message never reveals whether an account
  exists.
- **RBAC server-side**, with `SUPER_ADMIN` restricted to the emergency published-correction capability.
- **Audit trail** for administrative and correction actions; assignment history is append-only.
- **Unexpected server errors** return a fixed generic message; internal detail stays in the server log.

---

## Known limitations

These are **documented and accepted** for release 1.0.1. None of them is a release blocker.

1. **Per-user installation** under `%LOCALAPPDATA%\Programs\PNK Suguan`.
2. **`HKCU` installation registration** rather than an all-users / `HKLM` registration.
3. **No code signing.** Windows SmartScreen may therefore warn when the installer is first executed.
4. **No automatic updater.** Upgrades are performed by running a newer installer.
5. **No separate physical PC/VM clean-machine validation was available.** Clean-state installation was
   validated on the development host with a fresh, fully isolated install and data directory.
6. **No physically disconnected network test was performed.** Offline behaviour was validated
   structurally and at socket level (no external requests; loopback-only listeners).
7. **Correction-security test-order coupling** in the test suite remains tracked as pre-existing
   test-hygiene debt.
8. **One API-gated test remains skipped** when `PNK_API_TEST_URL` is not configured.
9. **In-place upgrade can leave stale Next.js static assets** from the previous build under
   `app/.next/static/<old-build-hash>/` (typically `_buildManifest.js`,
   `_clientMiddlewareManifest.js`, `_ssgManifest.js`). **Future maintenance item — not addressed in R1.**
   No functional, data, security or authorization impact has been demonstrated.

---

## Version identity

| Label | Value | Where it appears |
| --- | --- | --- |
| Installer / package version | **1.0.1** | Setup file name, Windows Apps & Programs, `INSTALL-INFO.json` |
| Application version | 0.1.0 | `BUILD-MANIFEST.json`, launcher `status` |
| Build ID | `20260920043134-c1f595` | `app/BUILD-ID`, `BUILD-MANIFEST.json` |
| Node.js runtime | v22.23.2 | `BUILD-MANIFEST.json`, bundled `node/node.exe` |
| PostgreSQL runtime | 16.14 | `BUILD-MANIFEST.json`, bundled `postgres/bin/postgres.exe` |

The payload carries **no source-control revision identifier** (it was not built from a tagged commit).
The authoritative identity of this release is its **SHA-256**, recorded above and in
`PNK-Suguan-Setup-1.0.1.sha256` and `MANIFEST.sha256`.

**No automatic updater, no telemetry, no analytics, no cloud sync and no background backup service are
present in this release.**

---

## Upgrading from 1.0.0

1.0.0 → 1.0.1 was tested as an in-place upgrade on an installation holding real data. Users, password
hashes, configuration, secrets, business data and audit history were preserved; the PostgreSQL cluster
was not reinitialised and existing migrations were not re-run. See `INSTALLATION-GUIDE.md` for the
procedure.

---

## Support

**«internal IT contact»** — placeholder. The validated release does not specify a support address,
e-mail, phone number, website or portal. Replace this with your organisation's support channel before
distribution.
