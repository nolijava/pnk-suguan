import { pgTable, text, timestamp, uuid, integer, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teachers } from "./teachers";

/**
 * Update #1 — individual birthday notice dedupe (teacher x birthday year x
 * stage), mirroring dako_anniversary_notifications.
 */
export const teacherBirthdayNotifications = pgTable(
  "teacher_birthday_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "cascade" }),
    birthdayYear: integer("birthday_year").notNull(),
    notificationType: text("notification_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teacher_birthday_dedupe").on(t.teacherId, t.birthdayYear, t.notificationType),
  ],
);

/**
 * Update #2 — GROUPED oath-anniversary notices: the dedupe key is
 * (anniversary month-day x year x stage), so multiple teachers sharing the same
 * anniversary date produce ONE combined notification listing all of them.
 * Stored oath dates are never modified.
 */
export const teacherAnniversaryNotifications = pgTable(
  "teacher_anniversary_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    anniversaryMonth: integer("anniversary_month").notNull(),
    anniversaryDay: integer("anniversary_day").notNull(),
    anniversaryYear: integer("anniversary_year").notNull(),
    notificationType: text("notification_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teacher_anniversary_group_dedupe").on(
      t.anniversaryMonth,
      t.anniversaryDay,
      t.anniversaryYear,
      t.notificationType,
    ),
    check("teacher_anniv_month_check", sql`"anniversary_month" BETWEEN 1 AND 12`),
    check("teacher_anniv_day_check", sql`"anniversary_day" BETWEEN 1 AND 31`),
  ],
);
