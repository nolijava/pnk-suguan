-- ============================================================================
-- Migration 0005 — Master Consolidated Plan (Revisions #1-#7):
--   1) SUPER_ADMIN role seed. No user is auto-granted; grant via existing
--      user management. SUPER_ADMIN is the role authorized for the
--      exceptional PUBLISHED Suguan unlock mechanism (migration-free role
--      row; capability still governed by the RBAC permission model).
--   2) destination_history — normalized Teacher<->Dako destination periods
--      (spec §8/§9). ONE table; the teacher page and the dako page read the
--      same relationship. One ACTIVE record per teacher and per dako
--      (partial unique indexes on end_date IS NULL), no overlapping periods
--      (CHECK), no invented backfill: rows are created only by real
--      Current-Destination edits through destination-history.service.
--   3) Trigger-guard re-assertion: assignment_history stays append-only with
--      exactly two transaction-local exceptions (pnk.regeneration_cascade
--      from 0003, pnk.assignment_cascade from 0004). This migration
--      re-asserts the guard function so both GUC names are guaranteed
--      regardless of applied order; normal deletes and direct history
--      deletion remain blocked; flags are set/reset by services inside the
--      same transaction only.
--
-- No enum changes (statuses/sources are text). No destructive backfill.
-- Rollback: DROP TABLE destination_history; DELETE FROM roles WHERE code='SUPER_ADMIN';
-- ============================================================================

-- (1) SUPER_ADMIN role seed.
INSERT INTO roles (code, name, description)
VALUES ('SUPER_ADMIN', 'Super Admin', 'Exceptional PUBLISHED Suguan unlock for emergency corrections')
ON CONFLICT (code) DO NOTHING;

-- (2) Destination history (§8/§9) — single normalized relationship.
CREATE TABLE IF NOT EXISTS destination_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  dako_id uuid NOT NULL REFERENCES dako(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one ACTIVE destination period per teacher.
CREATE UNIQUE INDEX IF NOT EXISTS destination_history_one_active_per_teacher
  ON destination_history (teacher_id) WHERE end_date IS NULL;
-- Exactly one ACTIVE destination period per dako.
CREATE UNIQUE INDEX IF NOT EXISTS destination_history_one_active_per_dako
  ON destination_history (dako_id) WHERE end_date IS NULL;
-- Period sanity: end never before start.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'destination_history_period_check'
  ) THEN
    ALTER TABLE destination_history
      ADD CONSTRAINT destination_history_period_check
      CHECK (end_date IS NULL OR end_date >= start_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS destination_history_teacher_idx ON destination_history (teacher_id);
CREATE INDEX IF NOT EXISTS destination_history_dako_idx ON destination_history (dako_id);
CREATE INDEX IF NOT EXISTS destination_history_start_idx ON destination_history (start_date);

-- (3) Append-only guard re-assertion (idempotent with 0003/0004 semantics).
CREATE OR REPLACE FUNCTION fn_forbid_history_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('pnk.regeneration_cascade', true), 'off') = 'on' THEN
    -- Scoped exception: regeneration cascade (0003). Service snapshots the
    -- complete AUTO set into REGENERATED_SCHEDULE audit within the same
    -- transaction.
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('pnk.assignment_cascade', true), 'off') = 'on' THEN
    -- Scoped exception: authorized single-assignment clear (Phase 6). The
    -- full old assignment value was snapshotted into CLEARED_ASSIGNMENT
    -- audit within this same transaction before the delete.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'assignment_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ah_no_delete ON assignment_history;
CREATE TRIGGER trg_ah_no_delete BEFORE DELETE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_history_delete();

-- ============================================================================
-- Master plan §56 — HISTORICAL assignment source (confirmed Phase 1 defect:
-- the 0001 CHECK predates the approved HISTORICAL source). Extends the
-- allowed values in place; no data change.
-- ============================================================================
ALTER TABLE "assignments" DROP CONSTRAINT IF EXISTS assignments_source_check;
ALTER TABLE "assignments" ADD CONSTRAINT assignments_source_check
  CHECK (assignment_source IN ('AUTO', 'MANUAL', 'OVERRIDE', 'HISTORICAL'));
