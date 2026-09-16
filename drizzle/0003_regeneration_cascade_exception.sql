-- ============================================================================
-- Migration 0003 — scoped history-cascade exception for schedule regeneration
-- (Phase 4; user-approved resolution, 2026-09-16)
--
-- Phase 4 regeneration replaces a DRAFT week's AUTO assignments inside one
-- transaction. Deleting an assignment row cascades (ON DELETE CASCADE) to its
-- assignment_history rows, but trg_ah_no_delete blanket-forbids every DELETE.
--
-- Approved resolution ("scoped trigger exception"): the append-only guarantee
-- remains absolute for every normal path. Deletion is allowed ONLY when the
-- transaction-local GUC pnk.regeneration_cascade is 'on' — set immediately
-- before the regeneration delete by the scheduling service. set_config(...,
-- is_local => true) scopes it to the transaction; it vanishes on commit or
-- rollback, so no other code path and no other session can ever hit it.
--
-- The REGENERATED_SCHEDULE audit row snapshots the complete previous AUTO set
-- before deletion, so history remains fully reconstructable.
--
-- No table, column, or FK changes. The UPDATE guard on assignment_history and
-- BOTH audit_logs guards are untouched and remain absolutely append-only.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_forbid_history_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('pnk.regeneration_cascade', true), 'off') = 'on' THEN
    -- Scoped exception: regeneration cascade (previous set already snapshotted
    -- into the REGENERATED_SCHEDULE audit row within this same transaction).
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'assignment_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ah_no_delete ON assignment_history;
CREATE TRIGGER trg_ah_no_delete BEFORE DELETE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_history_delete();
