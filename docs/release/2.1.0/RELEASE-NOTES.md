# PNK Suguan 2.1.0 — Release Notes

- Installer/package version: **2.1.0**
- Application version: **2.1.0**
- Build ID: `20260925100758-ac26a7` (recorded in `BUILD-MANIFEST.json` inside the package)
- Installer size: 88.4 MB (92,687,360 bytes)
- Installer SHA-256: `78ca817c00c8d0161f1344a512226912e06df019d6d983fc70d6f4d193f0f0f1`
- Database migration: `0013_destination_duty.sql` (additive; no column, table or row dropped)
- Bundled Node.js: v22.23.2
- Bundled PostgreSQL: 16.x (version recorded in the payload manifest)

This release implements **New Update Batch #1–#11**. The historical **Previous Update #1–#22** behaviour is unchanged and remains protected; the batch numbering restarts deliberately and is not a continuation of the earlier series.

## Why this is 2.1.0 and not 2.0.1

The schema changes, but **additively**: `destination_history` gains a nullable `duty` column and its per-dako uniqueness rule is widened from one active period per dako to one active period per (dako, duty). Nothing is dropped, no existing value is rewritten except the deliberate labelling described below, and every existing installation upgrades in place. Functionality is extended (reports, navigation, recovery) rather than redefined, so this is a minor release.

## What is in this batch

### New Update #1 — Dashboard Dako name at 8pt

The Dako NAME in the annual matrix's row header now renders at 8pt, the same size as the teacher names in the same row, so a row reads as one unit. Only the row header changes: the "Dako" column header keeps the table-header scale, and the sticky-column metrics, week-cell sizing, badge rendering, synchronized scrolling and current-week positioning are untouched.

### New Update #2 — Forgot Password / OTP delivery

The recovery pipeline itself was sound but **could not deliver anything, because SMTP had never been configured**: the send failed closed while the API kept returning its deliberate generic answer, so "no code arrived" and "the address is unknown" looked identical to the operator. This release makes the state visible and fixable:

- **Settings → Email delivery** reports CONFIGURED / NOT CONFIGURED truthfully, names the environment keys (never a secret), and states plainly that recovery cannot deliver a code until they are set.
- A **guarded delivery test** sends a secret-free message to the signed-in administrator's own address and reports the true outcome. It requires `users.manage`, and every attempt is audited (`EMAIL_TEST_SENT`).
- The server logs one secret-free startup warning when email is unconfigured.
- Behaviour when unconfigured is unchanged and deliberate: the request is still accepted, the code is still generated and stored hashed, and the reply is still the same generic sentence. Nothing about account existence is ever revealed.

SMTP is configured in **this machine's data folder** (`.env` next to the database), never in the database and never in the interface. Keys: `PNK_SMTP_HOST`, `PNK_SMTP_PORT`, `PNK_SMTP_SECURE`, `PNK_SMTP_USER`, `PNK_SMTP_PASS`, `PNK_SMTP_FROM`, or the single `PNK_SMTP_URL`. Restart the application after editing them. Codes remain single-use, expire after 10 minutes, lock after five wrong attempts, are stored only as a peppered HMAC, and are never written to a log, a URL, or another user's screen.

### New Update #3 — Super Admin instruction guide (PDF)

A procedure-only reference manual for the SUPER_ADMIN capability ships inside the package (`public/guides/SUPER-ADMIN-GUIDE.pdf`) and is linked from **Settings → Administrator documentation** for ADMIN and SUPER_ADMIN. It documents access, capabilities, the emergency correction of a PUBLISHED week, backup and restore, provisioning and recovery — and contains no passwords, keys, or secrets.

### New Update #4 — Teacher Masterlist report with field selection

A read-only masterlist of Teacher records with the page filters (status, language, duty) and a **field-selection step before export**: tick the fields to include and the PDF contains those columns in catalogue order. Age is always computed from Birthday. The selection is re-validated server-side against the same allow-list, and an unknown field code is rejected.

### New Update #5 — PDF for every report

Every report view now offers **Generate PDF**: source summary, annual per-type, weekly, per-teacher history, per-dako history, celebrations, and the Teacher Masterlist. Each route re-reads the same services the page uses, so the file matches the screen; the link carries the page's current filters, the response is an attachment, and nothing is cached. Read-only: producing a PDF changes no scheduling data and writes no audit rows. The accepted Weekly Suguan PDF (with its Patotoo slips) is unchanged.

### New Update #6, #7, #8 — Duty on the destination relationship

- **#7** — the Change Current Destination dialog takes a **Duty** (Destinado / Katuwang). Choosing a destination now requires choosing its duty; standing down is still allowed.
- **#6** — the teacher page shows the duty of the current destination and the duty held at each period in Destination History, and the duty travels with the period.
- **#8** — a dako's profile shows its **current assignment**: who holds Destinado and who holds Katuwang, since when, plus any active teacher whose period predates duty recording. A dako can therefore hold one Destinado and one Katuwang at the same time; the same slot can never have two holders, which the database enforces.

`teachers.duty` is retained and kept in step as the current-period mirror, because duty-based generation and the Magtuturo roster read it; the relationship row is the source of truth. Historical periods are labelled only from recorded facts — a period with no duty reads "—" and is never guessed. Migration 0013 labels the open period of a teacher whose recorded duty matches their current destination, and nothing else.

### New Update #9 — Global table typography

Table headers 10px, data cells 12.5px, badges 10px, in-table buttons 11px, applied consistently across the application, with the dashboard matrix keeping its own dedicated scale (8pt names, 11.5px badges) so no dashboard metric changes.

### New Update #10 — Distinctive dashboard micro-badge hues

Each micro-badge identifier now resolves to its own hue, in both light and dark themes. Two pairs were previously identical — OVERRIDE shared ABSENT's colour and FINALIZED shared UPDATED's — which made them indistinguishable to the eye. Icons, tooltips, the registry, the deterministic mapping, and reduced-motion behaviour are unchanged; meaning is still carried by shape and label, not colour alone.

### New Update #11 — Navigation restructured

Five top-level entries: **Dashboard · Schedule · Reports · Settings · Audit**.

- **Schedule** discloses Weekly Schedule, Availability, Magtuturo, and Historical Backfill.
- **Settings** discloses Teachers, Dako, Users (with `users.manage`), and Backup/Restore (with `backups.write` or `backups.restore`).
- **Audit** remains ADMIN-only.

Grouping changes where a page is *reached*, never whether it is *authorized*: every route is unchanged, direct URLs keep working, each page keeps its own server-side permission guard, and a role that could reach Teachers or Dako still can. The group header is a real button (`aria-expanded`/`aria-controls`), so it opens by click, by tap, and by keyboard — never by hover alone — and in the collapsed rail it restores the rail and then opens the group.

## Upgrade behaviour

- Applies `0013_destination_duty.sql` once, on first start of the new version.
- The migration is additive and guarded: it fails loudly rather than letting an ambiguous duplicate survive, and it changes nothing else.
- Existing installations have an empty `destination_history` in practice; the migration is then a pure column-and-index change.
- User data, users, passwords, configuration, assignments, availability, and audit history are preserved. The program folder is replaced; the data folder is not.

## Known limitations

- The installer is **not code-signed**; verify the SHA-256 through a trusted channel.
- No automatic updater, telemetry, cloud sync, or scheduled backup service.
- Recovery email requires SMTP keys in the data folder's `.env` **and an application restart**. Until then, Forgot Password accepts requests but delivers nothing (by design, and now visible in Settings).
- Report and masterlist PDFs contain the data the page is showing at the moment the link is followed — they are snapshots, not live views.
