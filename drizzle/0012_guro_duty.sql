-- ============================================================================
-- Migration 0012 -- Guro Duty (Destinado / Katuwang) + duty-based generation.
--
--   teachers.duty -- persistent teacher attribute ('DESTINADO' | 'KATUWANG')
--     used by the Assign Destinado / Assign Katuwang generation modes. The
--     column is NULLable on purpose: pre-existing rows have no duty and one
--     CANNOT be safely inferred — inventing values would affect scheduling.
--     Duty-less teachers simply take no part in duty-based generation until a
--     duty is set (genuine data requirement, never guessed).
--
--   assignments.generation_mode -- marks rows produced by the duty-based
--     generation modes ('ASSIGN_DESTINADO' | 'ASSIGN_KATUWANG'). NULL for rows
--     written by Auto-generate / manual / override workflows. Enables the
--     per-dako fair-rotation counts and keeps rotation decisions
--     reconstructable from stored assignments.
--
--   Rollback: ALTER TABLE "teachers" DROP COLUMN "duty";
--             ALTER TABLE "assignments" DROP COLUMN "generation_mode";
-- ============================================================================

ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "duty" text
  CHECK ("duty" IN ('DESTINADO', 'KATUWANG'));

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "generation_mode" text
  CHECK ("generation_mode" IN ('ASSIGN_DESTINADO', 'ASSIGN_KATUWANG'));

CREATE INDEX IF NOT EXISTS "assignments_generation_mode_idx"
  ON "assignments" ("generation_mode");
