import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ROLE_CODES = ["ADMIN", "SCHEDULER", "VIEWER", "SUPER_ADMIN"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
