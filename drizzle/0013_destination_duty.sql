-- ============================================================================
-- Migration 0013 -- Duty on the destination relationship.
--
--   destination_history.duty -- the persistent duty of ONE destination period
--     ('DESTINADO' | 'KATUWANG'), so history preserves the duty a teacher held
--     at each dako. NULLable on purpose: legacy periods have no recorded duty
--     and one is NEVER inferred — a duty-less period reads "—" everywhere.
--
--   The per-dako uniqueness rule widens from "one active period per dako" to
--   "one active period per (dako, duty)": a dako may hold one current Destinado
--   AND one current Katuwang, while the SAME slot can never have two holders.
--   Active rows with no recorded duty coalesce to '' and therefore keep the
--   ORIGINAL one-per-dako rule, so legacy data can never become ambiguous.
--
--   teachers.duty is NOT dropped and is NOT superseded as a writing target: it
--   keeps mirroring the duty of the current relationship (written in the same
--   transaction by assignDestination) because the duty-based generation modes
--   and the Magtuturo roster read it. The relationship row is the source of
--   truth; teachers.duty is its mirror for the current period only.
--
--   No column, table or row is dropped; no destructive backfill.
--
--   Rollback: DROP INDEX "destination_history_one_active_per_dako_duty";
--             CREATE UNIQUE INDEX "destination_history_one_active_per_dako"
--               ON "destination_history" ("dako_id") WHERE "end_date" IS NULL;
--             ALTER TABLE "destination_history" DROP COLUMN "duty";
-- ============================================================================

ALTER TABLE "destination_history" ADD COLUMN IF NOT EXISTS "duty" text
  CHECK ("duty" IN ('DESTINADO', 'KATUWANG'));

-- Backfill ONLY from recorded facts: the teacher's OWN duty, only for the OPEN
-- period, and only when that period is the teacher's current destination.
-- Closed periods are never touched; a duty-less teacher stays duty-less.
UPDATE "destination_history" dh
   SET "duty" = t."duty", "updated_at" = now()
  FROM "teachers" t
 WHERE dh."teacher_id" = t."id"
   AND dh."end_date" IS NULL
   AND dh."dako_id" = t."current_destination_id"
   AND dh."duty" IS NULL
   AND t."duty" IN ('DESTINADO', 'KATUWANG');

-- Safety assertion. The OLD invariant (one active period per dako) means no two
-- OPEN periods can already share a (dako, duty) slot, so this can only trip on a
-- database that was hand-edited. Fail LOUDLY and change nothing further rather
-- than let a duplicate survive the widened rule.
DO $$
DECLARE dup int;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT "dako_id", coalesce("duty", '') AS slot
      FROM "destination_history"
     WHERE "end_date" IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'migration 0013: % dako/duty slot(s) already hold more than one active period', dup;
  END IF;
END $$;

-- One active period per (dako, duty slot); legacy NULL duty keeps one-per-dako.
DROP INDEX IF EXISTS "destination_history_one_active_per_dako";
CREATE UNIQUE INDEX IF NOT EXISTS "destination_history_one_active_per_dako_duty"
  ON "destination_history" ("dako_id", coalesce("duty", ''))
  WHERE "end_date" IS NULL;
