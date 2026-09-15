import { pgTable, text, timestamp, uuid, index, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { users } from "./users";
import { dako } from "./dako";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    message: text("message"),
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_scheduled_idx").on(t.scheduledFor),
    index("notifications_read_idx").on(t.readAt),
  ],
);

export const dakoAnniversaryNotifications = pgTable(
  "dako_anniversary_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dakoId: uuid("dako_id")
      .notNull()
      .references(() => dako.id, { onDelete: "cascade" }),
    anniversaryYear: integer("anniversary_year").notNull(),
    notificationType: text("notification_type").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dako_anniv_dedupe_key").on(t.dakoId, t.anniversaryYear, t.notificationType),
  ],
);
