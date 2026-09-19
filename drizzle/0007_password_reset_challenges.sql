-- ============================================================================
-- Migration 0007 — Forgot password / account recovery (system update, Group 1)
--
--   password_reset_challenges stores ONE row per OTP request. Only hashes are
--   persisted: an HMAC-SHA256 of the 6-digit code (peppered with
--   PNK_OTP_PEPPER) and, after successful verification, a SHA-256 of the
--   one-time reset ticket. The plaintext code/ticket are never stored — not in
--   this table, not in audit rows, never logged, never returned to a client for
--   an existing account. The row itself is the recovery transaction: expiry
--   (10 min), attempt counter (max 5), single-use consumption marker, and the
--   requester IP backing the send rate limits.
--
--   No existing table is altered; `users` is untouched (a completed reset only
--   writes password_hash / must_change_password / updated_at through the
--   existing service, and revokes sessions via the existing session helpers).
--
--   Rollback: DROP TABLE password_reset_challenges;
-- ============================================================================

CREATE TABLE IF NOT EXISTS "password_reset_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "code_hash" text NOT NULL,
  "ticket_hash" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "verified_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "requested_ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  ALTER TABLE "password_reset_challenges"
    ADD CONSTRAINT "password_reset_challenges_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "password_reset_challenges_user_idx"
  ON "password_reset_challenges" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "password_reset_challenges_ip_idx"
  ON "password_reset_challenges" ("requested_ip", "created_at");
