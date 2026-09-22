# PNK Suguan 1.0.1 — Operations Guide

Day-to-day use of PNK Suguan: master data, availability, the weekly schedule, the DRAFT → FINALIZED →
PUBLISHED lifecycle, corrections, destinations, history, and PDF/report output.

The rules stated here are the rules the application enforces. Where a rule cannot be overridden, that is
said explicitly, because the difference matters when a schedule will not accept an assignment.

---

## 1. Master data

### Teachers — **Teachers**

Each teacher record carries a name and a **language** (`ENGLISH` or `FILIPINO`), status, and their
destination information. Teachers can be created, edited, viewed per teacher, deactivated
(`reactivate` restores them) and exported in reports.

The teacher's **language is a business-critical field**, not a label: it determines which dako the
teacher may be assigned to (section 2).

### Dako — **Dako**

Each dako record carries its name, its **language**, its purok group, and enabled/disabled status. Dako
records can be created, edited, enabled and disabled; a **disabled** dako cannot receive assignments at
all, and that restriction cannot be overridden by anyone.

---

## 2. The language rule (non-overridable)

| Dako language | Teachers it may receive |
| --- | --- |
| **ENGLISH** | English teachers **only** |
| **FILIPINO** | Filipino **or** English teachers |

Placing a **Filipino teacher on an English dako** raises **`LANGUAGE_MISMATCH`**. This is an **absolute
business rule**: no role — Administrator, Scheduler/Encoder, VIEWER or Super Admin — can override it, and
supplying a reason does not help. An override reason can clear other hard rules; it can never clear this
one or `DAKO_DISABLED`.

**The only remedy is to correct the teacher's profile language to `ENGLISH`** if that is genuinely true of
them, and then assign again.

The interface shows the mismatch on the candidate before you commit it (`LANGUAGE_MISMATCH — will be
rejected`), and the server enforces the same rule if the request is made another way.

---

## 3. Availability

**Availability** is maintained per week. Two properties matter operationally:

- **The current week and the next week are edited independently.** Changing next week's availability does
  not touch the current week's, and vice versa.
- Availability is what the schedule engine and the manual encoder consider when proposing candidates;
  it does not by itself create assignments.

Availability has its own correction window for a week that has moved past drafting, separate from the
schedule correction windows described in section 6.

---

## 4. The weekly schedule

Open **Schedule** to work on a week. The matrix shows dako against the week's days, with the assignment
cells for **SUGO**, **RESERBA** and **RESERBA II**.

### SUGO → RESERBA → RESERBA II

Every dako has **three ranked assignment attempts**, in this fixed order of preference:

| Rank | Type | Meaning |
| --- | --- | --- |
| 1 | **SUGO** | The primary assignment |
| 2 | **RESERBA** | The first fallback when SUGO cannot be filled |
| 3 | **RESERBA II** | The second fallback |

The three are independent annual tables, and they are ranked: **filling RESERBA II never deprives a dako
of SUGO or RESERBA**, and the order is never inverted.

### Generating a schedule

**Generation is DRAFT-only.** A schedule can be generated into a week that is in **DRAFT**; generation
into a finalized or published week is refused (`409`), not silently ignored. Generation proposes
assignments; it does not bypass the language rule or dako status, and structurally excluded candidates
(a Filipino teacher on an English dako, a disabled dako) never become eligible through generated output.

### Encoding by hand

You can also assign, change and clear assignments directly in the matrix using the candidate lists. The
same rules apply as for generation, plus per-teacher constraints such as being already assigned in that
week.

### Overriding a hard rule

Some hard rules (for example a teacher who was **absent the previous week**) can be overridden by an
**Administrator**, who must supply a **reason**; the override and its reason are audited. This is
deliberately narrower than it may sound:

- `LANGUAGE_MISMATCH` and `DAKO_DISABLED` are **not** in the overridable set — they are refused for every
  actor, with no override path;
- `assignment already exists this week` is a structural constraint enforced by the database itself, with
  no override path for anyone.

The interface tells you which rules a candidate violates, and whether they are overridable, before you
commit.

---

## 5. Week lifecycle: DRAFT → FINALIZED → PUBLISHED

| State | What it means | How you leave it |
| --- | --- | --- |
| **DRAFT** | Being encoded. Generation and free editing are allowed | Finalize it |
| **FINALIZED** | Locked for normal editing; can still be revised through the authorized correction window | Publish it, or revise it |
| **PUBLISHED** | The published schedule. Locked | Only a Super Admin correction (section 6) |

- **Finalizing** requires the `weeks.finalize` permission — Administrator or Super Admin.
- **Publishing** requires `weeks.publish` — Administrator or Super Admin.
- **A FINALIZED week does not revert to DRAFT.** Corrections preserve status; there is no "back to
  draft" step, and no global unlock.

---

## 6. Corrections

There are two distinct correction paths, and confusing them is the most common operational mistake.

### Finalized revision — authorized by `weeks.unlock`

Available to **Administrator**, **Super Admin** and **Scheduler/Encoder**. A **reason is mandatory**. The
correction window is temporary, and the week keeps its FINALIZED status throughout. Opening, using and
closing the window are audited.

### Published correction — Super Admin only

Correcting a **PUBLISHED** week is reserved for **Super Admin**. Every other role — including
Administrator — is denied. The capability:

- requires the **Super Admin unlock secret** held in `%LOCALAPPDATA%\PNK Suguan\.env`
  (`PNK_SUPER_ADMIN_SECRET`) in addition to normal authentication;
- is **temporary** (default window 30 minutes, closable at will);
- requires a **reason**;
- is **scoped** to the one week and to the account that opened it;
- is **status-preserving** — the week stays PUBLISHED; nothing is downgraded and no global unlock occurs;
- is **audited** in full;
- **fails closed** — if the secret is not configured, the path refuses every request.

Treat it as a break-glass action. It exists so that a genuine error in a published week can be fixed
without pretending the week was never published.

---

## 7. Destinations and history

These are separate from weekly assignments, deliberately.

### Current destination

A teacher's **current destination** is maintained on the teacher record. It is the answer to "where is
this teacher now", independent of any particular week's assignment.

### Weekly assignments do not touch it

**Encoding, changing or clearing a weekly assignment never modifies Current Destination, and never
modifies Destination History.** Weekly assignment data and destination data are distinct: working on a
week's schedule has no side effect on a teacher's destination record.

### Destination history

Destination history records destination changes over time, per teacher and per dako. It is presented as a
distinct historical record, visually separate from weekly assignment data, and it is append-only — it is
not rewritten by later schedule work.

### Historical Backfill

**Historical Backfill** exists to record *past* assignment data. It operates with **`HISTORICAL`** source
behaviour: it does **not** mutate the current master destination, and it does not rewrite current
destination records. Backfilled rows are historical records, not present-day state.

---

## 8. PDF and reports

### Weekly Suguan PDF

The **Weekly Suguan** physical form is produced as a **PDF** from the weekly schedule
(`/api/schedule/weekly-suguan-pdf`), for printing and filing. It is generated on the server from the
week's data.

**The PDF is read-only.** Producing it never changes schedule, assignment, destination or history data.
It is an output, not an editing surface.

**Who may produce it.** The PDF endpoint requires the **`assignments.write`** permission — the same one
that governs assignment editing. In practice that means an **Administrator** or a **Scheduler/Encoder**
can produce the printable form; a **Viewer is denied** (`403`) and an anonymous request is rejected
(`401`). A Viewer can read the schedule on screen but cannot obtain the printed Weekly Suguan form. A
year/week that has not been started returns `404`.

### Reports

Report views are available under **Reports**: the weekly report, the annual matrix report, and per-dako
and per-teacher reports. They are on-screen views for review and printing from the browser. Like the PDF,
they are read-only with respect to scheduling data.

---

## 9. Notifications and audit

- **Notifications** are informational messages about scheduling events. They can be read by every role;
  only Administrator and Super Admin can author them (`notifications.write`).
- **Audit log** — available to Administrator and Super Admin only. It records administrative actions,
  correction windows (including reasons) and overrides. Scheduler/Encoder and Viewer cannot read it.

---

## 10. A normal week, end to end

1. Confirm teachers and dako records, including each one's **language** (section 2).
2. Update **availability** for the week.
3. Open **Schedule** for the week — it must be in **DRAFT**.
4. **Generate** a DRAFT schedule, then review the matrix and adjust the SUGO / RESERBA / RESERBA II cells
   as needed, overriding a hard rule only when it is justified and overridable.
5. **Finalize** the week when encoding is complete.
6. If something needs changing, use the **FINALIZED revision** window with a reason (section 6).
7. **Publish** the week.
8. Produce the **Weekly Suguan PDF** for printing.
9. If a published week turns out to be wrong, use the **Super Admin** correction path — and record why.

Throughout, keep in mind: weekly assignment work never changes teacher destinations, generation is
DRAFT-only, and the language rule cannot be overridden by anyone.
