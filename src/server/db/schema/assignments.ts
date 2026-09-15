import { pgTable, text, timestamp, uuid, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { weeks } from "./weeks";
import { dako } from "./dako";
import { teachers } from "./teachers";
import { users } from "./users";

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekId: uuid("week_id")
      .notNull()
      .references(() => weeks.id, { onDelete: "restrict" }),
    dakoId: uuid("dako_id")
      .notNull()
      .references(() => dako.id, { onDelete: "restrict" }),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "restrict" }),
    assignmentType: text("assignment_type").notNull(),
    assignmentSource: text("assignment_source").notNull().default("MANUAL"),
    status: text("status").notNull().default("ASSIGNED"),
    isOverride: boolean("is_override").notNull().default(false),
    overrideReason: text("override_reason"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assignments_week_dako_type_key").on(t.weekId, t.dakoId, t.assignmentType),
    uniqueIndex("assignments_week_teacher_key").on(t.weekId, t.teacherId),
    index("assignments_week_idx").on(t.weekId),
    index("assignments_dako_idx").on(t.dakoId),
    index("assignments_teacher_idx").on(t.teacherId),
    index("assignments_type_idx").on(t.assignmentType),
  ],
);
