import { pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { teachers } from "./teachers";
import { weeks } from "./weeks";

export const teacherAvailability = pgTable(
  "teacher_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "restrict" }),
    weekId: uuid("week_id")
      .notNull()
      .references(() => weeks.id, { onDelete: "restrict" }),
    availabilityStatus: text("availability_status").notNull(),
    reason: text("reason"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teacher_availability_teacher_week_key").on(t.teacherId, t.weekId),
    index("teacher_availability_week_status_idx").on(t.weekId, t.availabilityStatus),
  ],
);
