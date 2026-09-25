-- ============================================================================
-- Migration 0008 -- Update #6: Priority Dako
--
--   dako.is_priority: persistent, per-dako, MULTI-select flag (NOT mutually
--   exclusive -- any number of dakos may be Priority simultaneously). The
--   RESERBA and RESERBA II allocation passes process Priority dakos first;
--   SUGO and all higher-priority eligibility rules are unchanged.
--
--   Additive only. Existing rows default to false (not Priority).
--
--   Rollback: DROP INDEX IF EXISTS "dako_is_priority_idx";
--             ALTER TABLE dako DROP COLUMN is_priority;
-- ============================================================================

ALTER TABLE "dako" ADD COLUMN IF NOT EXISTS "is_priority" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "dako_is_priority_idx" ON "dako" ("is_priority");
