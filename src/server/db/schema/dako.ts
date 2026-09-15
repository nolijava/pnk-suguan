import { pgTable, text, timestamp, uuid, date, index } from "drizzle-orm/pg-core";

export const dako = pgTable(
  "dako",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dakoCode: text("dako_code").notNull().unique(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    dateEstablished: date("date_established").notNull(),
    purokGrupo: text("purok_grupo"),
    worshipDay: text("worship_day").notNull(),
    worshipTime: text("worship_time").notNull(),
    language: text("language").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    dateDisabled: date("date_disabled"),
    disableReason: text("disable_reason"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dako_status_idx").on(t.status),
    index("dako_language_idx").on(t.language),
    index("dako_purok_grupo_idx").on(t.purokGrupo),
    index("dako_date_established_idx").on(t.dateEstablished),
  ],
);
