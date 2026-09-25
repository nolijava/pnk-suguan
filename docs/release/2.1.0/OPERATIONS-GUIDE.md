# PNK Suguan 2.1.0 — Operations Guide

Day-to-day use of PNK Suguan: navigation, master data, availability, the weekly schedule, the DRAFT → FINALIZED → PUBLISHED lifecycle, corrections, destinations and duty, history, the Magtuturo module, duty-based generation, reports and PDF output, backups, and recovery email.

The rules stated here are the rules the application enforces. Where a rule cannot be overridden, that is said explicitly, because the difference matters when a schedule will not accept an assignment.

---

## 1. Navigation

The sidebar has five top-level entries — **Dashboard · Schedule · Reports · Settings · Audit** — and two of them disclose the pages beneath them:

| Entry | Discloses |
|---|---|
| **Dashboard** | The annual matrix and Generate Suguan (opens directly) |
| **Schedule** | Weekly Schedule · Availability · Magtuturo · Historical Backfill |
| **Reports** | Every report (opens directly) |
| **Settings** | Teachers · Dako · Users · Backup/Restore |
| **Audit** | The audit log (ADMIN and SUPER_ADMIN only) |

A group header is a button: it opens by click, by tap, and by keyboard, never by hover alone. The group holding the page you are on opens itself and stays open. In the collapsed rail, activating a group header first restores the rail and then opens that group.

**Grouping changes where a page is reached, not what it is allowed to do.** Every route is unchanged, direct URLs keep working, and each page still enforces its own permission server-side. A role that lacks a permission does not receive the entry at all — but hiding it is presentation, never the protection.

---

## 2. Master data

### Teachers — **Settings → Teachers**

Each teacher record carries a name (middle name hidden in matrix displays, suffix kept), language (`ENGLISH` or `FILIPINO`), purok/grupo, status, destination information, and a **Duty** (`DESTINADO` or `KATUWANG`).

The teacher's **language is a business-critical field**: it determines which dako the teacher may be assigned to (section 4).

The teacher page shows the **Current Destination together with its Duty** and the full **Destination History**, where every period shows the duty held at that dako. Changing the current destination (or ending one) is done from the same page and takes a Duty — see section 6.

### Dako — **Settings → Dako**

Each dako record carries its name, its **language**, and enabled/disabled status. Dako records do not carry Purok/Grupo (removed in migration 0009); that field remains on teachers. A **disabled** dako cannot receive assignments at all, and that restriction cannot be overridden by anyone.

A dako may be marked **Priority** (multi-select — any number of dakos). Priority dakos are processed first in the RESERBA and RESERBA II allocation passes. SUGO and all higher-priority eligibility rules are unchanged.

A dako's page also shows its **Current Assignment**: who holds Destinado and who holds Katuwang, since when, alongside any active teacher whose period predates duty recording.

---

## 3. The language rule (non-overridable)

| Dako language | Teachers it may receive |
| --- | --- |
| **ENGLISH** | English teachers **only** |
| **FILIPINO** | Filipino **or** English teachers |

Placing a **Filipino teacher on an English dako** raises **`LANGUAGE_MISMATCH`**. This is an **absolute business rule**: no role — Administrator, Scheduler/Encoder, Viewer or Super Admin — can override it, and supplying a reason does not help. An override reason can clear other hard rules; it can never clear this one or `DAKO_DISABLED`.

**The only remedy is to correct the teacher's profile language to `ENGLISH`** if that is genuinely true of them, and then assign again.

The interface shows the mismatch on the candidate before you commit it, and the server enforces the same rule if the request is made another way.

---

## 4. Availability — the generation prerequisite

**Availability is maintained per week**, and it is the gate in front of all generation:

> **A week cannot be generated until every master-ACTIVE teacher has an availability record for it.** Master-inactive teachers are never required.

This applies to Auto-generate, Assign Destinado, Assign Katuwang, and the Manual entry point alike. The check is performed **server-side** — confirming the dialog does not bypass it — and every blocked attempt is audited with the week, the method, and how many teachers were missing.

The current week and the next week are edited independently. Availability still feeds candidate selection exactly as before; the prerequisite is about the record existing, not its value — a teacher encoded as ABSENT satisfies the gate (the engine simply will not pick them).

**Seeing the state in advance.** The dashboard's Annual matrix carries a readiness mark on every ISO-week column: a **filled dot** means the week is ready to generate, a **ring** means it is blocked, with the exact missing count in the tooltip. The legend above the tables names both states.

**Fixing a blocked week.** Click the blocked week's mark (or the action in any generation block notice) to open the Weekly Availability page in **Fix availability** mode: it repeats the gate's own sentence, highlights the teachers still needing a record, and offers **Fill N as AVAILABLE** — one confirmed action that encodes everyone missing. The guide and highlights disappear by themselves once nothing is missing.

---

## 5. The weekly cycle

1. Confirm teachers and dako records, including language and Duty.
2. Encode **availability** for the week (section 4) — the readiness mark on the dashboard confirms when it is complete.
3. Open **Schedule → Weekly Schedule** for the week — it must be in **DRAFT**.
4. **Generate** using Auto-generate, Assign Destinado, or Assign Katuwang (section 8), then review the matrix and adjust SUGO / RESERBA / RESERBA II cells as needed, overriding a hard rule only when it is justified and overridable.
5. **Finalize** the week when encoding is complete.
6. If something needs changing, use the **FINALIZED revision** window with a reason.
7. **Publish** the week.
8. Produce the **Weekly Suguan PDF** for printing.
9. Produce any **report PDF** the office needs (section 10).
10. If a published week turns out to be wrong, use the **Super Admin** correction path — and record why.

---

## 6. Current Destination and Duty

A teacher's destination is a **period**, not a single field: each period records the dako, the start date, and — new in 2.1.0 — the **Duty** held there (`DESTINADO` or `KATUWANG`).

- **Setting a destination requires its Duty.** Standing a teacher down needs no duty.
- Changing **only** the duty at the same dako updates the open period in place and is audited; re-assigning the identical destination and duty is a no-op, not a new row.
- The duty is attached to the **period**, so Destination History is truthful about what the teacher held at each dako over time.
- A dako may therefore hold **one Destinado and one Katuwang at the same time**. The same slot can never have two holders — the database enforces one active period per (dako, duty) — and legacy periods with no recorded duty keep the stricter one-per-dako rule.
- Teacher records still carry a duty, kept in step as the **mirror of the current period**, because duty-based generation and the Magtuturo roster read it. The relationship row is the source of truth; the mirror is written in the same transaction.
- Historical periods are **labelled only from recorded facts**. A period opened before duty recording reads "—" everywhere and is never guessed.

---

## 7. Generation and the dashboard

The dashboard's **Generate Suguan** modal combines two inputs: the **ISO week** to generate and the **generation method**. Both are submitted together on Confirm; the week's availability is validated before anything is generated. The Weekly Schedule page's **Generate Schedule** modal targets the week the page already displays and offers the three generating methods — hand encoding stays available per cell (Delegate/Override) regardless.

Generation always leaves the week in **DRAFT**. Regeneration replaces only generation-produced rows on the applicable dakos; cells you placed by hand (MANUAL/OVERRIDE) survive every regeneration.

The matrix itself: the Dako **name** in each row header renders at 8pt, the same size as the teacher names in that row, so a row reads as one consistent unit. Week cells, badges, the readiness marks, synchronized scrolling, and the current-week positioning are unchanged.

---

## 8. Guro Duty and the duty-based modes

Each dako's weekly roster is read from its teachers' recorded **Duty**:

| Mode | SUGO receives | RESERBA receives | Additional Katuwang |
| --- | --- | --- | --- |
| **Assign Destinado** | The dako's Destinado | That Destinado's Katuwang | — |
| **Assign Katuwang** | The dako's Katuwang | That dako's Destinado | Rotate fairly into RESERBA II |

The rotation is deterministic and computed from stored assignments, so it is fair across weeks and reconstructable from the data. All hard eligibility rules apply — duty does not exempt a teacher from language matching, absence, or a disabled dako. Dakos with no duty roster simply receive nothing from these modes; use Auto-generate or hand encoding there.

---

## 9. Mga Magtuturo sa Klase — **Schedule → Magtuturo**

**Magtuturo** is a separate teaching-assignment category — not part of the Suguan tables. Each week has exactly **4 SUGO seats and 2 RESERBA seats**, week-level (no dako dimension).

Generation follows fixed continuity rules: a previous week's SUGO teacher who is now absent **keeps** their seat; a previous RESERBA teacher who is available **progresses** to SUGO; hard rules always win over continuity. Remaining seats are filled by fair rotation, with eligible Katuwang extendable into the teaching seats. A **month view** aggregates the weekly results. The module has its own page and its own audit records.

---

## 10. Reports and PDF output — **Reports**

Every report view now offers **Generate PDF**, and the file always carries the filters the page is currently showing. Reports are read-only: producing one changes no scheduling data and writes no audit rows.

| Report | Contents |
|---|---|
| **Source summary** | Assignment counts by source (AUTO / MANUAL / OVERRIDE / HISTORICAL) × Suguan type |
| **Annual** | Per-type annual matrix for a year |
| **Weekly** | The week's SUGO / RESERBA / RESERBA II detail |
| **Teacher history** | One teacher's assignment history, filterable by year, source, and type |
| **Dako history** | One dako's assignment history, filterable the same way |
| **Celebrations** | Birthday celebrants and oath anniversaries for a month |
| **Teacher Masterlist** | Master data as stored, with **selectable columns** |

The **Teacher Masterlist** is the one report with a field-selection step: open **Generate PDF — choose fields…**, tick the information to export, and generate. Only the ticked fields are written, in catalogue order; **Age is always computed from Birthday and never stored**. "Select all", "Core fields", and "Clear" are shortcuts, and generation is disabled while nothing is ticked. The selection is validated again on the server, which rejects an unknown field code.

The **Weekly Suguan PDF** (`/schedule`) is separate and unchanged: Page 1 is the accepted physical form, followed by one page per populated assignment row carrying the Patotoo ORIGINAL/DUPLICATE slips. Producing it never changes scheduling data, and it requires the same permission as assignment editing (`assignments.write`). The week's Magtuturo teaching assignments are printed on the form alongside the Suguan sections.

Celebration **notifications** additionally appear in the header bell: individual birthday notices, and one **grouped** notice per oath-anniversary date.

---

## 11. Password recovery by email

Self-service recovery emails a six-digit code, which must be entered within 10 minutes; codes are single-use, lock after five wrong attempts, are stored only as a peppered hash, and are never written to a log, a URL, or another user's screen. The reply to a request is always the same generic sentence, whether or not the address exists — that is deliberate, and it is also why an unconfigured system looks like "nothing happened".

**Configuration lives in the data folder, never in the database or the interface:**

```text
%LOCALAPPDATA%\PNK Suguan\.env
PNK_SMTP_HOST / PNK_SMTP_PORT / PNK_SMTP_SECURE / PNK_SMTP_USER / PNK_SMTP_PASS / PNK_SMTP_FROM
   — or the single PNK_SMTP_URL
```

**Restart the application after editing the file** so the launcher passes the new values to the server.

**Settings → Email delivery** (requires `users.manage`) reports CONFIGURED / NOT CONFIGURED truthfully, names the keys, and offers **Send test email to my account** — a secret-free message sent to the signed-in administrator's own address, audited as `EMAIL_TEST_SENT`, whose result is reported as it actually happened. If the test fails, the page says so and states the configuration problem without revealing any credential; if it succeeds, the mail server accepted the message, and a missing message is a delivery/spam problem rather than a system problem.

---

## 12. Notifications and audit

- **Notifications** are informational messages about scheduling events and celebrants. Every role can read them; only Administrator and Super Admin can author them.
- **Audit log — Audit** (Administrator and Super Admin) records administrative actions, correction windows, overrides, backups and restores, destination and duty changes, blocked generation attempts (`GENERATION_BLOCKED`, with the week, method, and missing/total counts), and email delivery tests (`EMAIL_TEST_SENT`).

---

## 13. Backup and restore — **Settings → Backup/Restore**

**Create backup** writes a validated `pg_dump` archive of the database — to the default backup folder or an operator-chosen location — and **Restore** replays a chosen archive behind a typed confirmation, always writing a safety backup first. Every attempt, successful or failed, is audited; a failed backup is never reported as success.

Backups protect the **database**. They do not cover the whole user-data folder (configuration, the port file, the email `.env`, logs). For full protection, or for 1.0.x installations with no in-app feature, follow the manual procedure in `DATA-PRESERVATION-AND-BACKUP.md`. Scheduled backups remain out of scope.

The same page carries the **Administrator documentation** link to the Super Admin guide PDF that ships inside the package.

---

## 14. Interface conventions

- **Table typography** is consistent application-wide: 10px headers, 12.5px data cells, 10px badges, 11px buttons inside tables. The dashboard matrix keeps its own dedicated scale (8pt names, 11.5px badges) so no dashboard metric shifts.
- **Dashboard micro-badges** each carry their own hue — seven identifiers, seven colours — in both light and dark themes. Meaning is never carried by colour alone: every badge keeps its icon, its accessible label, and its tooltip.
- **Readiness marks, scroll synchronisation, and the current-week highlight** on the annual matrix are unchanged.
