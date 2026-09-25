-- ============================================================================
-- Migration 0009 -- Update #4: REMOVE Purok/Grupo from Dako
--
--   DESTRUCTIVE (explicitly approved): drops the dako-scoped display-only
--   purok_grupo column and its index. Guarded by the Section-5 safety protocol
--   (verified pg_dump of the actual configured target database BEFORE apply).
--
--   Teacher/Guro purok_grupo (teachers table) is deliberately UNTOUCHED.
--
--   Rollback: ALTER TABLE dako ADD COLUMN purok_grupo text;
--             (values recoverable only from the pre-migration safety backup)
-- ============================================================================

DROP INDEX IF EXISTS "dako_purok_grupo_idx";
ALTER TABLE "dako" DROP COLUMN IF EXISTS "purok_grupo";
