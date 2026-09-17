-- ============================================================================
-- Migration 0004 — Phase 6: code sequences + approved dako-code backfill
--                  + scoped assignment-clear cascade exception
--
-- 1) DAKO CODE BACKFILL (explicitly user-approved, 2026-09-17):
--    Existing production dakos use the legacy format ILG-D-1001..ILG-D-1011.
--    Per the approved Phase 6 numbering decision, they are unified to the new
--    ILGD-### format, preserving order:
--        ILG-D-1001 -> ILGD-100, ILG-D-1002 -> ILGD-101, ...
--        ILG-D-1011 -> ILGD-110
--    Verified safe before migration:
--      - zero duplicate codes (both dev/test clusters)
--      - no dako_code column exists outside the dako table; every relationship
--        is a UUID FK
--      - no source/test/doc dependency on the literal 'ILG-D-' format
--    Historical audit_logs JSON snapshots embedding the old codes are
--    intentionally NOT rewritten — they are historical records of what the
--    code was at the time. Rollback: map ILGD-N back to ILG-D-(N+901).
--
-- 2) CODE SEQUENCES (§20-§25): concurrency-safe, monotonic, never reused.
--    - pnk_teacher_code_seq START 1028 (existing codes PNK-G-1001..PNK-G-1027
--      are untouched; next generated = PNK-G-1028)
--    - pnk_dako_code_seq START 111 (continues after the backfilled ILGD-100..110)
--    Services draw codes via nextval INSIDE the insert transaction; gaps from
--    rolled-back creates are acceptable and permanent (no reuse).
--
-- 3) ASSIGNMENT-CLEAR CASCADE EXCEPTION (§C.1, clarification #1):
--    Phase 6 cell-clearing deletes ONE assignment row after server-side
--    authorization (assignments.write + assertWeekMutable rejects PUBLISHED).
--    The delete cascades to assignment_history, which the append-only guard
--    forbids. This extends migration 0003's guard with a SECOND transaction-
--    local GUC, pnk.assignment_cascade, set by clearAssignment() immediately
--    before its single DELETE and reset right after. is_local=>true scopes it
--    to the transaction (vanishes at commit/rollback); the client cannot set
--    session GUCs; regeneration GUC behavior is unchanged. The full old
--    assignment value is snapshotted into the CLEARED_ASSIGNMENT audit row
--    within the same transaction before deletion.
--
-- No table, column, or FK changes. audit_logs and assignment_history UPDATE
-- guards remain absolutely append-only.
-- ============================================================================

-- (1) Approved backfill: legacy ILG-D-#### -> ILGD-### (order preserved).
UPDATE dako
SET dako_code = 'ILGD-' || ((split_part(dako_code, '-', 3)::int - 1001) + 100)
WHERE dako_code LIKE 'ILG-D-%'
  AND split_part(dako_code, '-', 3) ~ '^\d+$';

-- (2) Concurrency-safe code sequences, positioned at the inspected maxima.
CREATE SEQUENCE IF NOT EXISTS pnk_teacher_code_seq START 1028;
CREATE SEQUENCE IF NOT EXISTS pnk_dako_code_seq START 111;

-- (3) Guard extension: second transaction-local exception for single-assignment
-- clears. Semantics identical to 0003 otherwise.
CREATE OR REPLACE FUNCTION fn_forbid_history_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('pnk.regeneration_cascade', true), 'off') = 'on' THEN
    -- Scoped exception: regeneration cascade (0003; unchanged behavior).
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('pnk.assignment_cascade', true), 'off') = 'on' THEN
    -- Scoped exception: authorized single-assignment clear (Phase 6). The full
    -- old assignment value was snapshotted into CLEARED_ASSIGNMENT audit
    -- within this same transaction before the delete.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'assignment_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ah_no_delete ON assignment_history;
CREATE TRIGGER trg_ah_no_delete BEFORE DELETE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_history_delete();
