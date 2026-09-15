import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { assignments } from "./assignments";
import { teachers } from "./teachers";
import { users } from "./users";

export const assignmentHistory = pgTable(
  "assignment_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    oldTeacherId: uuid("old_teacher_id").references(() => teachers.id),
    newTeacherId: uuid("new_teacher_id").references(() => teachers.id),
    oldAssignmentType: text("old_assignment_type"),
    newAssignmentType: text("new_assignment_type"),
    oldStatus: text("old_status"),
    newStatus: text("new_status"),
    changedBy: uuid("changed_by").references(() => users.id),
    changeReason: text("change_reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("assignment_history_assignment_idx").on(t.assignmentId),
    index("assignment_history_changed_at_idx").on(t.changedAt),
  ],
);
