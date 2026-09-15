import { pgTable, text, timestamp, uuid, integer, date, uniqueIndex, index } from "drizzle-orm/pg-core";

export const weeks = pgTable(
  "weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    year: integer("year").notNull(),
    isoWeekNumber: integer("iso_week_number").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: text("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("weeks_year_iso_week_number_key").on(t.year, t.isoWeekNumber),
    index("weeks_year_idx").on(t.year),
  ],
);
