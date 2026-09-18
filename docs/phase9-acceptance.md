# Phase 9 — Final Acceptance Matrix & Production Readiness

Statuses: **VERIFIED** (audited on this codebase with evidence), **FIXED** (Phase 9 corrected a defect), **PRESERVED** (implemented in an earlier phase, regression-protected), **N/A**.

Evidence keys: `T#` = test file (`tests/…`), `S#` = source location, `L#` = live walkthrough (dev preview, 2026-09-19).

## 1. Requirement matrix

| # | Requirement | Phase | Status | Evidence | Test |
|---|---|---|---|---|---|
| 1 | Teacher CRUD, auto codes (PNK-G-####), concurrency-safe | 1, 6 | PRESERVED | S: `teacher.service.ts`, `code-sequence` txn counter | T: `phase6.test.ts` |
| 2 | Dako CRUD, auto codes (ILGD-###), concurrency-safe | 1, 6 | PRESERVED | S: `dako.service.ts` | T: `phase6.test.ts` |
| 3 | Teacher language/status master data | 1 | PRESERVED | S: `schema/teachers.ts` | T: `constraints.test.ts` |
| 4 | Availability (Available/Absent/Inactive), master-over-weekly precedence | 2, 9 | PRESERVED | S: `availability.service.ts`, `effective-status` util | T: `effective-status.test.ts`, `phase3.test.ts` |
| 5 | Scheduling engine: SUGO → RESERBA → RESERBA II, RESERBA II leftover-pool | 3 | PRESERVED | S: `scheduling/generateSchedule.ts` | T: `scheduling-core.test.ts`, `phase3.test.ts` |
| 6 | Deterministic 8-tier fairness hierarchy, no randomness | 3, 9 | VERIFIED | S: `scheduling/scoring.ts` (ordered comparators only) | T: `scheduling-core.test.ts` |
| 7 | Previous-week ABSENT hard exclusion + fresh-check notice (Proceed/Review/Cancel) | 3 | PRESERVED | S: `scheduling/prev-absences.ts`, generate UI confirm | T: `phase3.test.ts` |
| 8 | Filipino → English dako impossible everywhere; LANGUAGE_MISMATCH non-overridable | 5 | VERIFIED | S: `assignment.service.ts` rejects before override branch | T: `phase5-language.test.ts`, `phase9-security.test.ts` (override path) |
| 9 | Week lifecycle DRAFT/FINALIZED/PUBLISHED; generation DRAFT-only | 4 | PRESERVED | S: `week.service.ts`, `assertScheduleCorrectable` | T: `phase4.test.ts` |
| 10 | FINALIZED correctable only via authorized, holder-scoped, audited workflow | 4 | VERIFIED | S: `correction.service.ts` (grant holder check in-txn) | T: `correction-unlock.test.ts`, `phase9-security.test.ts` |
| 11 | PUBLISHED locked; only SUPER_ADMIN secret unlock, week-scoped, time-boxed, status unchanged | 4 (master rev.) | VERIFIED | S: `correction.service.ts`, timing-safe compare, fail-closed env | T: `correction-unlock.test.ts`, `correction-security.test.ts` |
| 12 | SUPER_ADMIN cannot bypass LANGUAGE_MISMATCH | 5 | VERIFIED | S: `isNonOverrideableRule` rejects all actors | T: `correction-unlock.test.ts` |
| 13 | Next-week availability editable after Finalize/Publish | 4 | PRESERVED | S: availability routes scope by week | T: `phase4.test.ts` |
| 14 | Destination History normalized; weekly ops never mutate it; one active period per teacher/dako | 5 (master rev.) | PRESERVED | S: `destination-history` schema + partial unique indexes | T: `destination-history.test.ts` |
| 15 | Historical Backfill isolated (pre-go-live only, both directions); HISTORICAL source immutable | 5 | PRESERVED | S: `historical.service.ts` | T: `phase5-historical.test.ts` |
| 16 | Historical assignments count toward fairness | 5 | PRESERVED | S: scoring counts all sources | T: `phase5-historical.test.ts` |
| 17 | Regeneration never deletes MANUAL/OVERRIDE/HISTORICAL | 4/6 | PRESERVED | S: guarded cascade keeps protected sources | T: `phase6.test.ts`, `phase4.test.ts` |
| 18 | Assignment history append-only; direct DELETE blocked by DB guard | 6, 9 | VERIFIED | S: `assignment_history` trigger; GUC local to txn | T: `phase9-security.test.ts`, `constraints.test.ts` |
| 19 | Annual dashboard: 3 stacked tables, sticky Dako, synced scroll, current-week, source badges | 5 | PRESERVED | S: `annual-client.tsx` | L: Phase 5/6 walkthroughs |
| 20 | Phase 6 cell workflows: clear (Change of Suguan / Absent), modify+replace, atomic, audited | 6 | PRESERVED | S: `assignment.service.ts` clear/replace txn | T: `phase6.test.ts` |
| 21 | Weekly Suguan PDF: 612×936pt one page, read-only, exact form | 7 | PRESERVED | S: `pdf/weekly-suguan.ts` | T: `phase7-pdf.test.ts` |
| 22 | Reports read-only, real data, HISTORICAL verbatim, no N+1 | 8, 9 | VERIFIED | S: `reports.service.ts` (pure SELECT) | T: `phase8.test.ts` (read-only proof) |
| 23 | Notifications: ownership, idempotent anniversary scan, ADMIN-only scan, no scheduling side-effects | 8, 9 | VERIFIED | S: `notification.service.ts`, `instrumentation.ts` | T: `phase8.test.ts`, `phase9-security.test.ts` |
| 24 | Anonymous requests rejected on every API route | 9 | FIXED→VERIFIED | S: `guard.ts` on all handlers | T: `phase9-security.test.ts` sweep (57 handlers) |
| 25 | 500 responses leak no internals | 9 | FIXED | S: `api/helpers.ts` generic body | T: `phase9-security.test.ts` |
| 26 | Login brute force throttled, no enumeration | 9 | FIXED | S: `auth/login-throttle.ts` + `auth.service.ts` | T: `phase9-security.test.ts` |
| 27 | Security headers on all responses | 9 | FIXED | S: `next.config.ts` | T: `phase9-security.test.ts` |
| 28 | SUPER_ADMIN secret handling (server-only, timing-safe, generic failure, never logged) | 4/9 | VERIFIED | S: `correction.service.ts`, no secret in any log line | T: `correction-security.test.ts` |
| 29 | VIEWER read-only / SCHEDULER bounded / SUPER_ADMIN = ADMIN set | 9 | VERIFIED | S: `auth/permissions.ts` | T: `phase9-security.test.ts` RBAC matrix |

## 2. Phase 9 audit → disposition summary

| Audit area | Finding | Disposition |
|---|---|---|
| Anonymous access | All 57 route handlers guarded | VERIFIED via sweep test |
| Error handling | `fail()` returned raw messages for unexpected 500s | **FIXED** (generic body; detail server-side) |
| Authentication | No brute-force backoff on `login()` | **FIXED** (per-account+IP exponential throttle) |
| Transport/headers | No CSP/XFO/nosniff/Referrer-Policy | **FIXED** (static `next.config.ts` headers) |
| IDOR | Ownership enforced (notifications, correction grants, week-scoped ops) | VERIFIED + tests added |
| Input validation | Zod schemas on every route/service boundary; no mass assignment | VERIFIED |
| Secrets | Argon2id passwords; hashed session tokens; SUPER_ADMIN secret timing-safe, body-only, fail-closed | VERIFIED |
| Concurrency | Codes via txn counters; grants holder-checked in-txn; dedupe unique indexes | VERIFIED |
| History integrity | Append-only trigger + transaction-local GUC guard | VERIFIED |
| Reports/PDF/notifications | Read-only proven by byte-equality proof tests | VERIFIED |
| Dependencies | 6 moderate advisories, all dev-only tooling | Documented advisory; upgrades out of scope |
| Performance | Set-based queries; batched annual/report loads; indexes match queries | VERIFIED; no speculative indexes added |
| Schema | No integrity gap found requiring migration | **NO DATABASE/SCHEMA CHANGE REQUIRED** |

## 3. Production readiness checklist

| Item | Class | Notes |
|---|---|---|
| Authentication (argon2id, session TTL/revocation) | A | verified |
| Authorization / RBAC matrix | A | verified + tests |
| IDOR / ownership | A | verified + tests |
| Input validation (Zod, all boundaries) | A | verified |
| Secrets handling (SUPER_ADMIN secret, session, passwords) | A | verified; secret lives only in process env |
| Anonymous sweep of all API routes | A | test-enforced |
| Language hard rule (FIL→EN never) | A | test-enforced on every path |
| PUBLISHED lock + scoped SUPER_ADMIN unlock | A | verified |
| FINALIZED correction workflow | A | verified |
| Transactions/concurrency | A | verified |
| Assignment history append-only | A | DB guard + tests |
| Audit logging coverage | A | verified; never logs secrets |
| Reports/PDF/dashboards/notifications read-only | A | byte-equality proofs |
| Scheduling determinism & fairness | A | unit + integration |
| Error sanitization | A | **Phase 9 fix** |
| Login throttling | A | **Phase 9 fix** |
| Security headers | A | **Phase 9 fix** |
| Dev-only dependency advisories | B | documented; upgrade separately |
| `PNK_SUPER_ADMIN_SECRET` provisioning in prod | D | operator action (secret store) |
| Production DB + backups (`pg_dump` schedule) | D | operator action |
| TLS/reverse proxy, process manager | D | deployment environment |
| Initial admin bootstrap + password change | D | one-time operator step |
| Instrumentation timer (in-process ~6h scan) | A | boots verified in prod build smoke |
| Mobile/responsive polish | B | preserved; no redesign in scope |

Classes: A = verified/compliant · B = existing-and-preserved · C = gap requiring implementation (none remain) · D = operational/deployment action · E = N/A.

## 4. Verification gates (this phase)

| Gate | Result |
|---|---|
| Phase 9 security suite | 16/16 passed |
| Full regression | **295 passed / 1 skipped (20 files)** |
| Typecheck (`tsc --noEmit`) | clean |
| Production build | ✓ compiled, 30/30 pages |
| Runtime smoke (prod build boot) | server healthy, instrumentation timer active |
| Migration | none required |
