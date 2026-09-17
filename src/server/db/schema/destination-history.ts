import { pgTable, text, timestamp, uuid, date, index } from "drizzle-orm/pg-core";
import { teachers } from "./teachers";
import { dako } from "./dako";

/**
 * Destination history (Master Plan §8/§9) — the single normalized
 * teacher<->dako destination relationship. One ACTIVE record per teacher and
 * per dako (partial unique indexes in migration 0005); periods never overlap;
 * records are created ONLY by real Current-Destination edits (no invented
 * backfill). Weekly Suguan assignments NEVER create or modify rows here.
 */
export const destinationHistory = pgTable(
  "destination_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "restrict" }),
    dakoId: uuid("dako_id")
      .notNull()
      .references(() => dako.id, { onDelete: "restrict" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("destination_history_teacher_idx").on(t.teacherId),
    index("destination_history_dako_idx").on(t.dakoId),
    index("destination_history_start_idx").on(t.startDate),
  ],
);
