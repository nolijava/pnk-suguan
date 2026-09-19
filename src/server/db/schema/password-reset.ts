import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Forgot-password challenges (system update — Group 1).
 *
 * One row per OTP request. Only HASHES are stored (HMAC-SHA256 of the code,
 * SHA-256 of the reset ticket) — the code and ticket never touch the database,
 * logs, responses, URLs, or client storage. The row is the transaction: it
 * carries the expiry, the attempt counter, the single-use consumption marker,
 * and the requester IP used for rate limiting.
 */
export const passwordResetChallenges = pgTable(
  "password_reset_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    /** Set only after a successful code verification (single-use reset ticket). */
    ticketHash: text("ticket_hash"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: text("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("password_reset_challenges_user_idx").on(t.userId, t.createdAt),
    index("password_reset_challenges_ip_idx").on(t.requestedIp, t.createdAt),
  ],
);
