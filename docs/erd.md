# Entity Relationship Diagram — Phases 1–2

> **Phase 2 note:** the Master Data Management phase introduced **no schema migration** —
> the diagram and constraints below are unchanged from Phase 1. Phase 2 adds behavior
> and semantics on top of this schema (see "Phase 2 semantics" at the end).

```
┌────────────┐        ┌──────────────┐        ┌────────────┐
│   roles    │◄───────│  user_roles  │───────►│   users    │
└────────────┘  M:N   └──────────────┘        └─────┬──────┘
                                                    │ 1:N (cascade)
                    ┌───────────────────────────────┼──────────────┐
                    │                               │              │
             ┌──────▼──────┐                 ┌──────▼──────┐  ┌────▼─────────┐
             │  sessions   │                 │ notifications│ │  audit_logs  │
             └─────────────┘                 └─────────────┘  └──────────────┘

┌────────────┐  current_destination_id   ┌────────────┐
│    dako    │◄──────────────────────────│  teachers  │
└─────┬──────┘   (profile-level, §10)    └─────┬──────┘
      │ 1:N                          1:N       │
      │                              ┌─────────┴───────────┐
      │                              │                     │
┌─────▼───────────┐        ┌─────────▼──────────┐   ┌──────▼──────────────┐
│  assignments    │        │ teacher_availability│  │ (profile fields:     │
└─────┬───────────┘        │ (unique teacher+wk) │  │  birthday, language…)│
      │ 1:N                └────────────────────┘   └─────────────────────┘
┌─────▼──────────────┐
│ assignment_history │ (append-only; also FKs teachers ×2, users)
└────────────────────┘

┌────────────┐
│   weeks    │──1:N──► assignments, teacher_availability
└────────────┘  (unique year+iso_week_number; status DRAFT/FINALIZED/PUBLISHED)

┌────────────────────────────────┐
│ dako_anniversary_notifications │──N:1──► dako (dedupe: dako+year+type, §28)
└────────────────────────────────┘

Views: profiles (credential-free users + roles),
       v_assignment_counts (teacher×dako×type counts, §35)
```

## Relationship explanations

| Relationship | Cardinality | Purpose |
|---|---|---|
| roles ↔ user_roles ↔ users | M:N | Extensible role system (§7); a user may hold several roles; permissions merge server-side. |
| users → sessions | 1:N cascade | DB-backed sessions; deleting a user kills their sessions. |
| users → audit_logs | 1:N (SET NULL on delete) | Who changed what (§26/§37); log survives user removal. |
| users → notifications | 1:N cascade | Per-user inbox (§27). |
| dako → teachers.current_destination_id | 1:N nullable | Permanent home base; **separate** from weekly assignments (§10). Phase 2: maintained **only** by the audited destination operation (reason required; ACTIVE-dako-only for new selections); if the dako is later disabled the relationship is preserved as reference data. |
| dako → assignments | 1:N restrict | Weekly serving slots; a dako with assignments cannot be hard-deleted (§29). |
| teachers → assignments | 1:N restrict | Historical assignments keep referencing inactive teachers (§14). |
| weeks → assignments / teacher_availability | 1:N restrict | Everything is anchored to an ISO week row (§15/§17). |
| assignments → assignment_history | 1:N cascade | Full change trail per assignment: original → final teacher/type/status (§25). Trigger-maintained; append-only. |
| dako → dako_anniversary_notifications | 1:N cascade | Dedupe ledger preventing duplicate anniversary notifications per dako+year+type (§28). |
| teachers → teacher_availability | 1:N restrict | Weekly AVAILABLE/ABSENT/INACTIVE records; profile data untouched (§17/§18). |

## Uniqueness & integrity highlights

- `weeks(year, iso_week_number)` unique — one row per ISO week, week 53 supported.
- `teacher_availability(teacher_id, week_id)` unique — no duplicate weekly records.
- `assignments(week_id, dako_id, assignment_type)` unique — slot filled once.
- `assignments(week_id, teacher_id)` unique — one assignment per teacher per week.
- `dako_anniversary_notifications(dako_id, anniversary_year, notification_type)` unique — §28 dedupe.
- CHECKs mirror controlled vocabularies (statuses, types, sources, languages, worship day/time, ISO week 1–53).
- Lifecycle coherence: INACTIVE teachers must have `date_inactive`; DISABLED dako must have `date_disabled`.

## Phase 2 semantics on this schema

- **No new tables, columns, or migrations.** All Phase 2 requirements were met by the
  existing Phase 1 structures.
- `teachers.current_destination_id` is maintained exclusively by
  `changeCurrentDestination` (set/change/clear, mandatory reason, audited as
  `CHANGED_CURRENT_DESTINATION`). It never modifies `assignments`,
  `assignment_history`, or `teacher_availability` — verified by snapshot-equality tests.
- New Current Destination selections must reference an **ACTIVE** dako (also enforced on
  teacher create/edit); an existing destination whose dako is later disabled is
  **preserved**, not cleared.
- Soft lifecycle only: teacher deactivate/reactivate and dako disable/enable write
  `date_inactive`/`date_disabled` + reasons; reactivation clears the *current* inactive
  fields while every historical cycle stays recoverable in append-only `audit_logs`.
- Derived values (teacher age, inactive duration, dako anniversary) are computed at
  display time from `birthday` / `date_inactive` / `date_established` and are never
  stored as editable master data.
