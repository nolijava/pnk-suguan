-- ============================================================================
-- Migration 0011 -- Updates #1/#2: Birthday + Guro Anniversary (Panunumpa)
--   celebrant notices.
--
--   teacher_birthday_notifications -- Update #1 individual birthday notice;
--     dedupe (teacher x birthday year x stage), mirroring the existing
--     dako_anniversary_notifications pattern.
--
--   teacher_anniversary_notifications -- Update #2 GROUPED oath-anniversary
--     notices: dedupe key = (anniversary month-day x year x stage), so teachers
--     sharing the same anniversary date produce ONE combined notification.
--     Stored oath dates are never modified.
--
--   Rollback: DROP TABLE teacher_birthday_notifications;
--             DROP TABLE teacher_anniversary_notifications;
-- ============================================================================

CREATE TABLE IF NOT EXISTS "teacher_birthday_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "teacher_id" uuid NOT NULL REFERENCES "teachers"("id") ON DELETE CASCADE,
  "birthday_year" integer NOT NULL,
  "notification_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "teacher_birthday_dedupe"
  ON "teacher_birthday_notifications" ("teacher_id", "birthday_year", "notification_type");

CREATE TABLE IF NOT EXISTS "teacher_anniversary_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "anniversary_month" integer NOT NULL,
  "anniversary_day" integer NOT NULL,
  "anniversary_year" integer NOT NULL,
  "notification_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "teacher_anniv_month_check" CHECK ("anniversary_month" BETWEEN 1 AND 12),
  CONSTRAINT "teacher_anniv_day_check" CHECK ("anniversary_day" BETWEEN 1 AND 31)
);

CREATE UNIQUE INDEX IF NOT EXISTS "teacher_anniversary_group_dedupe"
  ON "teacher_anniversary_notifications" ("anniversary_month", "anniversary_day", "anniversary_year", "notification_type");
