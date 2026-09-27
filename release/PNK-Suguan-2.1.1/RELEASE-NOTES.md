# PNK Suguan 2.1.1 — Release Notes

## Magtuturo duty-neutral rotation

Magtuturo rotation no longer depends on regular Suguan duty or Current
Destination. The old behavior — eligible KATUWANG teachers grouped per Current
Destination dako taking the teaching seats first, with everyone else falling
back to a global pool — is removed entirely. One unified eligible pool now
fills the ordinary seats, ranked by:

1. lowest cumulative Magtuturo assignment count,
2. oldest last Magtuturo assignment when counts are tied,
3. the teacher ID as a deterministic final tie-breaker.

Ranking inputs are exclusively Magtuturo assignment history/counts. Regular
Suguan assignments, duty status, and Current Destination have no effect on
Magtuturo priority.

## Preserved behavior

- SUGO + ABSENT continuity: an absent SUGO teacher carries their seat over
  (21.4) and still outranks the ordinary rotation.
- RESERBA promotion: a non-ABSENT RESERBA teacher is promoted to SUGO (21.5);
  an ABSENT RESERBA teacher is not promoted and returns to ordinary rotation.
- Hard eligibility rules (21.6–21.8): master INACTIVE, weekly INACTIVE,
  NOT_ENCODED, oath-date rules, and the English-Dako exclusion are unchanged.
- Exactly 4 SUGO + 2 RESERBA seats per week.
- ISO-week based weekly and monthly generation, including October 2026
  resolving to ISO weeks 40–44 with 30 seats.
- Regular Suguan scheduling behavior is unchanged.

## Upgrade

No database migration is required. Follow the 2.1.0 installation guide; the
installer replaces program files and preserves the separate user-data
directory. 2.1.1 supersedes the earlier internal 2.1.1 build
(`20260927-2.1.1-patch`) — it contains that build's Magtuturo current-week
positioning plus this rotation correction.

## Verification record

- Full Vitest suite: 51 files, 696 passed, 1 skipped.
- Focused Magtuturo suites in the clean release worktree: 18 passed
  (rotation comparator, month, duty-neutrality, enhancements including
  October 2026 ISO weeks 40–44 / 30 seats).
- TypeScript typecheck: passed.
- Playwright Magtuturo current-week suite: 6/6 passed.
- Production build (Next.js standalone): passed; existing dynamic
  filesystem-tracing warnings from startup checks and backup services remain
  non-blocking.
- Installer payload audit: zero forbidden-content findings, zero audit
  failures.
- Isolated installation smoke test: installed into a test program directory
  with an isolated `PNK_DATA_DIR`; first run initialized a fresh database,
  applied migrations, provisioned the administrator, reported health ready,
  accepted login, and rendered `/magtuturo` with the duty-neutral description
  and the full weekly history table. The existing installation, its data,
  registry entry, and shortcuts were preserved and restored afterwards.
