# PNK Suguan 2.0.0 — Operations Guide

Day-to-day use of PNK Suguan: master data, availability, the weekly schedule, the DRAFT → FINALIZED → PUBLISHED lifecycle, corrections, destinations, history, the Magtuturo module, duty-based generation, backups, and PDF/report output.

The rules stated here are the rules the application enforces. Where a rule cannot be overridden, that is said explicitly, because the difference matters when a schedule will not accept an assignment.

---

## 1. Master data

### Teachers — **Teachers**

Each teacher record carries a name (middle name hidden in matrix displays, suffix kept), language (`ENGLISH` or `FILIPINO`), purok/grupo, status, destination information, and — new in 2.0.0 — a **Duty** (`DESTINADO` or `KATUWANG`).

The teacher's **language is a business-critical field**: it determines which dako the teacher may be assigned to (section 2).

**Duty is the input to duty-based generation** (section 6). It is never inferred: a teacher with no recorded duty takes no part in Assign Destinado / Assign Katuwang until a duty is set. Setting a duty is ordinary master-data editing, audited like any other change.

### Dako — **Dako**

Each dako record carries its name, its **language**, and enabled/disabled status. Dako records no longer carry Purok/Grupo (removed in migration 0009); that field remains on teachers. A **disabled** dako cannot receive assignments at all, and that restriction cannot be overridden by anyone.

A dako may be marked **Priority** (multi-select — any number of dakos). Priority dakos are processed first in the RESERBA and RESERBA II allocation passes. SUGO and all higher-priority eligibility rules are unchanged.

---

## 2. The language rule (non-overridable)

| Dako language | Teachers it may receive |
| --- | --- |
| **ENGLISH** | English teachers **only** |
| **FILIPINO** | Filipino **or** English teachers |

Placing a **Filipino teacher on an English dako** raises **`LANGUAGE_MISMATCH`**. This is an **absolute business rule**: no role — Administrator, Scheduler/Encoder, Viewer or Super Admin — can override it, and supplying a reason does not help. An override reason can clear other hard rules; it can never clear this one or `DAKO_DISABLED`.

**The only remedy is to correct the teacher's profile language to `ENGLISH`** if that is genuinely true of them, and then assign again.

The interface shows the mismatch on the candidate before you commit it, and the server enforces the same rule if the request is made another way.

---

## 3. Availability — now a generation prerequisite

**Availability is maintained per week**, and as of 2.0.0 it is the gate in front of all generation:

> **A week cannot be generated until every master-ACTIVE teacher has an availability record for it.** Master-inactive teachers are never required.

This applies to Auto-generate, Assign Destinado, Assign Katuwang, and the Manual entry point alike. The check is performed **server-side** — confirming the dialog does not bypass it — and every blocked attempt is audited with the week, the method, and how many teachers were missing.

The current week and the next week are edited independently, as before. Availability still feeds candidate selection exactly as it did; the prerequisite is about the record existing, not its value — a teacher encoded as ABSENT satisfies the gate (the engine simply will not pick them).

**Seeing the state in advance.** The dashboard's Annual matrix carries a readiness mark on every ISO-week column: a **filled dot** means the week is ready to generate, a **ring** means it is blocked, with the exact missing count in the tooltip. The legend above the tables names both states.

**Fixing a blocked week.** Click the blocked week's mark (or the action in any generation block notice) to open the Weekly Availability page in **Fix availability** mode: it repeats the gate's own sentence, highlights the teachers still needing a record, and offers **Fill N as AVAILABLE** — one confirmed action that encodes everyone missing. The guide and highlights disappear by themselves once nothing is missing.

---

## 4. The weekly cycle

1. Confirm teachers and dako records, including language and Duty.
2. Encode **availability** for the week (section 3) — the readiness mark on the dashboard confirms when it is complete.
3. Open **Schedule** for the week — it must be in **DRAFT**.
4. **Generate** using Auto-generate, Assign Destinado, or Assign Katuwang (section 6), then review the matrix and adjust SUGO / RESERBA / RESERBA II cells as needed, overriding a hard rule only when it is justified and overridable.
5. **Finalize** the week when encoding is complete.
6. If something needs changing, use the **FINALIZED revision** window with a reason.
7. **Publish** the week.
8. Produce the **Weekly Suguan PDF** for printing.
9. If a published week turns out to be wrong, use the **Super Admin** correction path — and record why.

---

## 5. Generation and the dashboard

The dashboard's **Generate Suguan** modal combines two inputs: the **ISO week** to generate and the **generation method**. Both are submitted together on Confirm; the week's availability is validated before anything is generated. The Weekly Schedule page's **Generate Schedule** modal targets the week the page already displays and offers the three generating methods — hand encoding stays available per cell (Delegate/Override) regardless.

Generation always leaves the week in **DRAFT**. Regeneration replaces only generation-produced rows on the applicable dakos; cells you placed by hand (MANUAL/OVERRIDE) survive every regeneration.

---

## 6. Guro Duty and the duty-based modes

Each dako's weekly roster is read from its teachers' recorded **Duty**:

| Mode | SUGO receives | RESERBA receives | Additional Katuwang |
| --- | --- | --- | --- |
| **Assign Destinado** | The dako's Destinado | That Destinado's Katuwang | — |
| **Assign Katuwang** | The dako's Katuwang | That dako's Destinado | Rotate fairly into RESERBA II |

The rotation is deterministic and computed from stored assignments, so it is fair across weeks and reconstructable from the data. All hard eligibility rules apply — duty does not exempt a teacher from language matching, absence, or a disabled dako. Dakos with no duty roster simply receive nothing from these modes; use Auto-generate or hand encoding there.

---

## 7. Mga Magtuturo sa Klase

**Magtuturo** is a separate teaching-assignment category — not part of the Suguan tables. Each week has exactly **4 SUGO seats and 2 RESERBA seats**, week-level (no dako dimension).

Generation follows fixed continuity rules: a previous week's SUGO teacher who is now absent **keeps** their seat; a previous RESERBA teacher who is available **progresses** to SUGO; hard rules always win over continuity. Remaining seats are filled by fair rotation, with eligible Katuwang extendable into the teaching seats. A **month view** aggregates the weekly results. The module has its own page under **Magtuturo** and its own audit records.

---

## 8. PDF and reports

The **Weekly Suguan PDF** (`/schedule`) is produced from the week's data for printing and filing: Page 1 is the accepted physical form, followed by one page per populated assignment row carrying the Patotoo ORIGINAL/DUPLICATE slips. **The PDF is read-only** — producing it never changes scheduling data, and it requires the same permission as assignment editing (`assignments.write`). The week's Magtuturo teaching assignments are printed on the form alongside the Suguan sections, so the physical form reflects both categories.

Report views — weekly, annual matrix, per-dako, per-teacher, and the **celebrations report** (birthdays and oath anniversaries) — are read-only on-screen views. Celebration **notifications** additionally appear in the header bell: individual birthday notices, and one **grouped** notice per oath-anniversary date.

---

## 9. Notifications and audit

- **Notifications** are informational messages about scheduling events and celebrants. Every role can read them; only Administrator and Super Admin can author them.
- **Audit log** (Administrator and Super Admin) records administrative actions, correction windows, overrides, backups/restores, and — new in 2.0.0 — **blocked generation attempts** (`GENERATION_BLOCKED`, with the week, method, and missing/total counts).

---

## 10. Backup and restore

**Settings → Backup** creates a validated `pg_dump` archive of the database — to the default backup folder or an operator-chosen location — and **Restore** replays a chosen archive behind a typed confirmation. Every attempt, successful or failed, is audited; a failed backup is never reported as success.

Backups protect the **database**. They do not cover the whole user-data folder (configuration, the port file, logs). For full protection, or for 1.0.x installations with no in-app feature, follow the manual procedure in `DATA-PRESERVATION-AND-BACKUP.md`. Scheduled backups remain out of scope.

---

## 11. Roles at a glance

Authorization is enforced server-side; see `USER-ROLE-GUIDE.md`. Generation (any mode) requires the `scheduling.generate` permission — Administrator and Scheduler/Encoder. Availability encoding requires `availability.write`. Backup creation requires `backups.write` (Administrator and Scheduler/Encoder); **restore** requires `backups.restore` (Administrator and SUPER_ADMIN only). Viewer remains read-only throughout.
