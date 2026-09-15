import { pgTable, text, timestamp, uuid, date } from "drizzle-orm/pg-core";
import { dako } from "./dako";
import { index } from "drizzle-orm/pg-core";

export const teachers = pgTable(
  "teachers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherCode: text("teacher_code").notNull().unique(),
    firstName: text("first_name").notNull(),
    middleName: text("middle_name"),
    lastName: text("last_name").notNull(),
    suffix: text("suffix"),
    birthday: date("birthday"),
    purokGrupo: text("purok_grupo"),
    dateOfOath: date("date_of_oath"),
    currentDestinationId: uuid("current_destination_id").references(() => dako.id),
    language: text("language").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    dateInactive: date("date_inactive"),
    inactiveReason: text("inactive_reason"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("teachers_status_idx").on(t.status),
    index("teachers_language_idx").on(t.language),
    index("teachers_purok_grupo_idx").on(t.purokGrupo),
    index("teachers_current_destination_idx").on(t.currentDestinationId),
  ],
);
