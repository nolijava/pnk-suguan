PNK Suguan 2.1.1 — Magtuturo duty-neutral rotation
===================================================

Installer/package version : 2.1.1
Application version       : 2.1.1
Payload build ID          : 20260927152531-ab11aa
Installer filename        : PNK-Suguan-Setup-2.1.1.exe
Installer size            : 87.7 MB (91,943,424 bytes)
Installer SHA-256         : 0470abb8d781041e521219b88189d2e02956556d44d3eda50bbcb140bbbbcd8f
Database migration        : None

WHAT CHANGED

Magtuturo rotation is now duty-neutral. The eligible Magtuturo pool no
longer gives priority to teachers whose regular Suguan duty is KATUWANG,
no longer groups candidates by their Current Destination dako, and never
uses regular Suguan assignments or history as a ranking input.

Ordinary Magtuturo seats are now filled from one unified eligible pool,
ranked by:
  1. lowest cumulative Magtuturo assignment count,
  2. oldest last Magtuturo assignment (when counts are tied),
  3. the teacher ID as a deterministic final tie-breaker.

PRESERVED BEHAVIOR

- SUGO + ABSENT continuity (a SUGO teacher who is ABSENT carries over).
- Non-ABSENT RESERBA promotion to SUGO; ABSENT RESERBA is not promoted.
- Hard eligibility rules, including the English-Dako exclusion, master
  INACTIVE, weekly INACTIVE, NOT_ENCODED, and oath-date rules.
- Exactly 4 SUGO + 2 RESERBA per week.
- ISO-week based weekly and monthly generation (October 2026 resolves
  to ISO weeks 40-44, 30 seats).
- Regular Suguan scheduling behavior is unchanged.

UPGRADE

No database migration is required. Follow the 2.1.0 installation guide;
the installer replaces program files and preserves the separate
user-data directory.

Note: 2.1.1 supersedes the earlier internal 2.1.1 build
("20260927-2.1.1-patch"). It contains that build's Magtuturo
current-week positioning plus this rotation correction, so installing
this build brings an already-updated machine fully current.

VERIFICATION RECORD

- Full Vitest suite: 51 files, 696 passed, 1 skipped.
- Focused Magtuturo suites in the clean release worktree: 18 passed
  (rotation comparator, month, duty-neutrality, enhancements including
  October 2026 ISO weeks 40-44 / 30 seats).
- TypeScript typecheck: passed.
- Playwright Magtuturo current-week suite: 6/6 passed.
- Production build (Next.js standalone): passed; existing dynamic
  filesystem-tracing warnings from startup checks and backup services
  remain non-blocking.
- Installer payload audit: zero forbidden-content findings, zero
  audit failures.
- Isolated installation smoke test: installed into a test program
  directory with an isolated PNK_DATA_DIR; first run initialized a
  fresh database, applied migrations, provisioned the administrator,
  reported health ready, accepted login, and rendered /magtuturo with
  the duty-neutral description and the full weekly history table. The
  existing installation, its data, registry entry, and shortcuts were
  preserved and restored afterwards.
