# PNK Suguan 2.0.0 — Release Notes

- Installer/package version: **2.0.0**
- Application version: **2.0.0** (the payload and installer versions agree for the first time since 1.0.x)
- Build ID: `20260924160110-bdba2b` (recorded in the payload manifest)
- Bundled Node.js: v22.23.2
- Bundled PostgreSQL: 16.x (version recorded in the payload manifest)
- Installer SHA-256: `49b4c961ab6afd17dc9282c341a9da7ece36257dc2fa2eb874518ba45406ff46`

## Why this is 2.0.0

Two changes make this a major release rather than a feature increment:

1. **The database schema changed structurally.** Migrations 0008–0012 add columns and tables and **remove** a column (`dako.purok_grupo`). Every existing installation must migrate to upgrade.
2. **The core scheduling workflow changed behaviorally.** Generation is now **blocked** until the selected week's availability is encoded (see below). Installations that previously generated schedules on unencoded weeks cannot continue that practice.

## Included capability

### Weekly Availability prerequisite (generation gate)

No week can be generated — by any method — until its required availability exists. "Required" means every **master-ACTIVE** teacher; master-inactive teachers are never required. The rule is enforced **server-side** on both generation paths (`POST /api/scheduling/generate` and the read-only `GET /api/scheduling/generation-gate` probe), so it cannot be bypassed from the interface. Blocked attempts are audited (`GENERATION_BLOCKED`) with the week, the method, and the missing/total counts, and change nothing — a blocked `{year, week}` attempt does not even create the week row.

The interface surfaces the rule before an operator hits it:

- The **Generate Suguan** modal (dashboard) carries an ISO WEEK selector alongside the four generation methods; Confirm validates the selected week first and shows a "Weekly Availability Required" notice with a direct action on failure.
- The **Weekly Schedule** page's Generate Schedule modal offers Auto-generate / Assign Destinado / Assign Katuwang (Manual encoding stays available per cell) against the week the page displays.
- The **Annual matrix** shows a per-week readiness mark on every ISO-week column: a filled dot for ready, a ring for blocked, with the exact count in its tooltip/accessible name.
- A blocked week links into **"Fix availability"** mode on the Weekly Availability page, which repeats the gate's own sentence, highlights the teachers still missing, and offers a one-click fill (still behind its confirm dialog).

### Mga Magtuturo sa Klase (class teachers)

A teaching-assignment category **separate** from normal Suguan: exactly 4 SUGO seats and 2 RESERBA seats per week, week-level (no dako dimension), stored in its own `magtuturo_assignments` table so the normal assignments table, unique indexes, engine, and reports are untouched. Generation follows continuity rules (previous week's absent SUGO teachers keep seats; previous RESERBA teachers progress to SUGO; hard rules always win), then fair rotation; eligible Katuwang may take teaching seats when the roster needs extending. A month view aggregates the weekly results.

### Guro Duty and duty-based generation

Each Guro record may carry a **Duty** — `DESTINADO` or `KATUWANG` — as a persistent attribute. Two generation modes use it:

- **Assign Destinado** puts each dako's Destinado in SUGO with its Katuwang in RESERBA.
- **Assign Katuwang** puts the Katuwang in SUGO with the Destinado in RESERBA; additional Katuwang rotate fairly into RESERBA II.

Both use deterministic fair rotation computed from stored assignments (`assignments.generation_mode` marks their rows), respect all hard eligibility rules, replace only generation-produced rows on the applicable dakos, leave MANUAL/OVERRIDE cells untouched, and keep the week in DRAFT. Duty-less teachers take no part in duty-based generation until a duty is set — the value is never inferred.

### Operator Backup / Restore

The Settings page offers pg_dump-based backups with integrity validation, to a default location or an operator-chosen folder, and a file-based restore gated behind a strong typed confirmation. Failures are audited (`BACKUP_FAILED`) and never reported as success. Scheduled backups remain out of scope.

### Teacher celebration notices

Individual birthday notices and grouped oath-anniversary notices (teachers sharing an anniversary date produce one combined notice). Stored oath dates are never modified.

### Interface refinements

Dashboard teacher names render at 8pt with middle names hidden and suffixes kept; micro-badges (PUBLISHED, FINALIZED, OVERRIDE, MANUAL, HISTORICAL, UPDATED, ABSENT) annotate matrix cells with accessible labels and tooltips; the three annual tables keep synchronized scrolling with equal week columns and a SUGO-only top scrollbar.

## Migrations 0008–0012

| Migration | Change | Nature |
|---|---|---|
| `0008_priority_dako` | `dako.is_priority` multi-select flag; RESERBA/RESERBA II passes process priority dakos first | Additive |
| `0009_drop_dako_purok_grupo` | **Drops** `dako.purok_grupo` and its index | **Destructive** (approved; teacher purok/grupo untouched) |
| `0010_magtuturo_assignments` | New `magtuturo_assignments` table (4 SUGO + 2 RESERBA seats) | Additive |
| `0011_teacher_celebration_notifications` | Birthday + grouped anniversary notice tables with dedupe keys | Additive |
| `0012_guro_duty` | `teachers.duty` (nullable) + `assignments.generation_mode` (nullable, indexed) | Additive |

Migrations are applied by the launcher process on upgrade. Migration 0009 is destructive: a pre-migration safety backup of the target database is part of its approved procedure, and the dropped values are recoverable only from that backup.

## Security and operation

Loopback-only binding, server-side RBAC, and the existing session model are unchanged. PostgreSQL and application data stay under `%LOCALAPPDATA%\PNK Suguan\`. No credentials or runtime data are packaged. SUPER_ADMIN remains an exceptional, separately provisioned role.

## Limitations

Per-user installation, HKCU registration, no code signing, no automatic updater, and no scheduled backup service remain documented limitations, as do the correction-security test-order coupling and one API-gated skipped test when email is not configured. Duty values are a data-entry prerequisite for duty-based generation — the system will not infer them.
