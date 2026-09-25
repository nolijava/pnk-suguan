-- ============================================================================
-- Migration 0010 -- Update #21: Mga Magtuturo sa Klase
--
--   A SEPARATE assignment category from normal Suguan (21.14): its own table so
--   the normal assignments table, its unique indexes, the scheduling engine and
--   every existing report remain untouched (21.15).
--
--   Slots per week: exactly 4 SUGO (seat 1-4) + 2 RESERBA (seat 1-2) = 6.
--   No dako dimension (class teachers are week-level, not dako-level).
--
--   Rollback: DROP TABLE magtuturo_assignments;
-- ============================================================================

CREATE TABLE IF NOT EXISTS "magtuturo_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "week_id" uuid NOT NULL REFERENCES "weeks"("id") ON DELETE CASCADE,
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE RESTRICT,
  "mag_type" text NOT NULL,
  "seat" integer NOT NULL,
  "assignment_source" text DEFAULT 'AUTO' NOT NULL,
  "status" text DEFAULT 'ASSIGNED' NOT NULL,
  "is_override" boolean DEFAULT false NOT NULL,
  "override_reason" text,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "assigned_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "magtuturo_type_check" CHECK ("mag_type" IN ('SUGO', 'RESERBA')),
  CONSTRAINT "magtuturo_seat_check" CHECK (
    ("mag_type" = 'SUGO' AND "seat" BETWEEN 1 AND 4) OR
    ("mag_type" = 'RESERBA' AND "seat" BETWEEN 1 AND 2)
  ),
  CONSTRAINT "magtuturo_source_check" CHECK ("assignment_source" IN ('AUTO', 'MANUAL', 'OVERRIDE')),
  CONSTRAINT "magtuturo_status_check" CHECK ("status" IN ('ASSIGNED', 'ABSENT', 'INACTIVE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "magtuturo_week_teacher_key"
  ON "magtuturo_assignments" ("week_id", "teacher_id");
CREATE UNIQUE INDEX IF NOT EXISTS "magtuturo_week_type_seat_key"
  ON "magtuturo_assignments" ("week_id", "mag_type", "seat");
CREATE INDEX IF NOT EXISTS "magtuturo_week_idx" ON "magtuturo_assignments" ("week_id");
CREATE INDEX IF NOT EXISTS "magtuturo_teacher_idx" ON "magtuturo_assignments" ("teacher_id");
