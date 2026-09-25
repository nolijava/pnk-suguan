import { pgTable, text, timestamp, uuid, integer, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { weeks } from "./weeks";
import { teachers } from "./teachers";

/**
 * Update #21 — Mga Magtuturo sa Klase assignments (21.14: a SEPARATE category
 * from normal Weekly Suguan). The normal `assignments` table, its unique
 * indexes and the scheduling engine are untouched (21.15).
 *
 * Exactly 4 SUGO (seat 1-4) + 2 RESERBA (seat 1-2) per week. No dako dimension:
 * class teachers are week-level, not dako-level. One assignment per teacher per
 * week (unique week_id+teacher_id).
 */
export const magtuturoAssignments = pgTable(
  "magtuturo_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekId: uuid("week_id").notNull().references(() => weeks.id, { onDelete: "cascade" }),
    teacherId: uuid("teacher_id").notNull().references(() => teachers.id, { onDelete: "restrict" }),
    magType: text("mag_type").notNull(), // SUGO | RESERBA
    seat: integer("seat").notNull(), // SUGO 1-4, RESERBA 1-2
    assignmentSource: text("assignment_source").notNull().default("AUTO"), // AUTO | MANUAL | OVERRIDE
    status: text("status").notNull().default("ASSIGNED"),
    isOverride: boolean("is_override").notNull().default(false),
    overrideReason: text("override_reason"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("magtuturo_week_teacher_key").on(t.weekId, t.teacherId),
    uniqueIndex("magtuturo_week_type_seat_key").on(t.weekId, t.magType, t.seat),
    index("magtuturo_week_idx").on(t.weekId),
    index("magtuturo_teacher_idx").on(t.teacherId),
    check("magtuturo_type_check", sql`"mag_type" IN ('SUGO', 'RESERBA')`),
    check(
      "magtuturo_seat_check",
      sql`("mag_type" = 'SUGO' AND "seat" BETWEEN 1 AND 4) OR ("mag_type" = 'RESERBA' AND "seat" BETWEEN 1 AND 2)`,
    ),
    check("magtuturo_source_check", sql`"assignment_source" IN ('AUTO', 'MANUAL', 'OVERRIDE')`),
    check("magtuturo_status_check", sql`"status" IN ('ASSIGNED', 'ABSENT', 'INACTIVE')`),
  ],
);

export type MagtuturoAssignment = typeof magtuturoAssignments.$inferSelect;
export type MagType = "SUGO" | "RESERBA";
