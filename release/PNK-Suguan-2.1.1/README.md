# PNK Suguan 2.1.1 — Magtuturo duty-neutral rotation

PNK Suguan 2.1.1 makes the Magtuturo rotation duty-neutral: ordinary Magtuturo
seats are filled from one unified eligible pool ranked only by Magtuturo
assignment history — lowest cumulative Magtuturo assignment count first, the
older last Magtuturo assignment when counts are tied, and the teacher ID as a
deterministic final tie-breaker. Regular Suguan duty (Destinado/Katuwang) and
Current Destination are no longer ranking inputs, and no Katuwang-first pool
remains.

Preserved behavior: SUGO + ABSENT continuity, non-ABSENT RESERBA promotion
(ABSENT RESERBA is not promoted), all hard eligibility rules including the
English-Dako exclusion, exactly 4 SUGO + 2 RESERBA per week, and ISO-week based
weekly/monthly generation (October 2026 resolves to ISO weeks 40–44, 30 seats).
Regular Suguan scheduling behavior is unchanged, and no database migration is
required.

| Item | Value |
|---|---|
| Release | PNK Suguan 2.1.1 |
| Application version | 2.1.1 |
| Installer version | 2.1.1 |
| Payload build ID | `20260927152531-ab11aa` |
| Installer | `PNK-Suguan-Setup-2.1.1.exe` |
| Installer size | 87.7 MB (91,943,424 bytes) |
| Installer SHA-256 | `0470abb8d781041e521219b88189d2e02956556d44d3eda50bbcb140bbbbcd8f` |
| Database migration | None |

2.1.1 supersedes the earlier internal 2.1.1 build (`20260927-2.1.1-patch`,
Magtuturo current-week positioning only): this release contains that
positioning behavior plus the rotation correction, so installing it brings an
already-updated machine fully current. See [RELEASE-NOTES.txt](RELEASE-NOTES.txt)
for the full record and [VERIFY-RELEASE.txt](VERIFY-RELEASE.txt) for checksum
verification instructions.
