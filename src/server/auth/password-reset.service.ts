/**
 * Self-service account recovery (system update — Group 1).
 *
 * Flow: request (email) → 6-digit CSPRNG code by email → verify → one-time
 * reset ticket → set a new password → all sessions revoked → user signs in.
 *
 * Security contract (every point is enforced here, never in the UI):
 *   • No account enumeration. `requestPasswordReset` ALWAYS reports the same
 *     generic outcome, whether the address exists, is inactive, or is
 *     rate-limited. The email send is fire-and-forget so the response time
 *     does not depend on whether a delivery happened.
 *   • Codes are cryptographically random (`randomInt`), stored only as an
 *     HMAC-SHA256 (peppered with PNK_OTP_PEPPER), single-use, 10-minute TTL,
 *     5 attempts, and never logged / returned / placed in a URL.
 *     Without the pepper the flow refuses to issue codes at all (fail closed).
 *   • Rate limits are DATABASE-backed (they survive restarts and are shared by
 *     every process): 60s resend cooldown, 3 sends/account/hour,
 *     10 sends/IP/hour.
 *   • A successful verification mints an opaque 32-byte single-use ticket
 *     (stored hashed, own 10-minute window) scoped to that account only — it
 *     cannot be replayed, reused, or pointed at another user.
 *   • Completion reuses the EXISTING argon2id hashing, forces
 *     `must_change_password = false` (the user chose this password), consumes
 *     the challenge, and revokes every existing session.
 *   • Only hashes and non-secret metadata reach the audit trail.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { getDb, withTransaction, type Database } from "@/server/db/client";
import { passwordResetChallenges, users } from "@/server/db/schema";
import { hashPassword } from "./password";
import { revokeAllSessionsForUser } from "./session";
import { audit } from "@/server/services/audit.service";
import { checkPasswordStrength } from "@/lib/password-strength";
import { ValidationError } from "@/lib/errors";
import { sendPasswordResetCode, emailConfigurationProblem } from "./email";

export const PASSWORD_RESET_TTL_MINUTES = 10;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;

const CODE_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
const TICKET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_ACCOUNT_PER_HOUR = 3;
const MAX_SENDS_PER_IP_PER_HOUR = 10;

/** Identical for every outcome — the only message the endpoint ever returns. */
export const GENERIC_RESET_MESSAGE =
  "If an account exists for this email, a verification code has been sent.";

function pepper(): string | null {
  const value = process.env.PNK_OTP_PEPPER?.trim();
  // Short peppers are rejected so a misconfigured secret cannot weaken the hash.
  return value && value.length >= 16 ? value : null;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(userId: string, code: string, secret: string): string {
  return createHmac("sha256", secret).update(`${userId}:${code}`).digest("hex");
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function auditSafely(entry: Parameters<typeof audit>[0]): Promise<void> {
  try {
    await audit(entry);
  } catch {
    // Recovery must not fail because the audit write did; the configuration
    // error is reported without any secret material.
    console.error("[password-reset] audit write failed");
  }
}

/** Best-effort client IP for rate limiting (proxy header first hop). Never logged. */
export function clientIpFrom(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]?.trim() : (req.headers.get("x-real-ip") ?? "");
  return ip && ip.length > 0 ? ip : "unknown";
}

export interface RequestResetResult {
  message: string;
}

/**
 * Step 1 — always resolves with the same generic message. Nothing about the
 * account (existence, status, delivery, throttling) is observable.
 */
export async function requestPasswordReset(rawEmail: string, clientIp: string): Promise<RequestResetResult> {
  const email = normaliseEmail(rawEmail);
  const secret = pepper();
  if (!secret) {
    console.error("[password-reset] PNK_OTP_PEPPER is missing or too short — recovery disabled (fail closed)");
    return { message: GENERIC_RESET_MESSAGE };
  }

  const db = getDb();
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000);

  // Rate limits are checked before touching the account so a throttled request
  // behaves identically for known and unknown addresses.
  const ip = clientIp || "unknown";
  const [ipCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(passwordResetChallenges)
    .where(and(eq(passwordResetChallenges.requestedIp, ip), gte(passwordResetChallenges.createdAt, hourAgo)));
  if ((ipCount?.n ?? 0) >= MAX_SENDS_PER_IP_PER_HOUR) return { message: GENERIC_RESET_MESSAGE };

  const accountRows = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const account = accountRows[0];

  const accountKey = account?.id ?? null;
  if (accountKey) {
    const [accountCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(passwordResetChallenges)
      .where(
        and(eq(passwordResetChallenges.userId, accountKey), gte(passwordResetChallenges.createdAt, hourAgo)),
      );
    if ((accountCount?.n ?? 0) >= MAX_SENDS_PER_ACCOUNT_PER_HOUR) {
      return { message: GENERIC_RESET_MESSAGE };
    }
    const [latest] = await db
      .select({ createdAt: passwordResetChallenges.createdAt })
      .from(passwordResetChallenges)
      .where(eq(passwordResetChallenges.userId, accountKey))
      .orderBy(desc(passwordResetChallenges.createdAt))
      .limit(1);
    if (latest && now - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return { message: GENERIC_RESET_MESSAGE };
    }
  }

  if (!account || account.status !== "ACTIVE") {
    await auditSafely({
      user: null,
      action: "PASSWORD_RESET_REQUESTED",
      entityType: "USER",
      entityId: null,
      reason: "recovery requested for an unknown or inactive account",
    });
    return { message: GENERIC_RESET_MESSAGE };
  }

  const code = generateCode();
  const expiresAt = new Date(now + CODE_TTL_MS);

  // One active challenge per account: every earlier unconsumed row is retired.
  await db
    .update(passwordResetChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(eq(passwordResetChallenges.userId, account.id), isNull(passwordResetChallenges.consumedAt)),
    );
  await db.insert(passwordResetChallenges).values({
    userId: account.id,
    codeHash: hashCode(account.id, code, secret),
    expiresAt,
    requestedIp: ip,
  });

  await auditSafely({
    user: null,
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "USER",
    entityId: account.id,
    reason: "self-service recovery code issued",
  });

  // Fire-and-forget: the HTTP response must not depend on SMTP latency, or the
  // timing difference would reveal whether the account exists.
  void sendPasswordResetCode({
    to: account.email,
    fullName: account.fullName,
    code,
    expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
  })
    .then((result) => {
      if (!result.delivered) {
        const problem = emailConfigurationProblem();
        if (problem) console.error(`[password-reset] ${problem}`);
      }
    })
    .catch(() => console.error("[password-reset] email delivery failed"));

  return { message: GENERIC_RESET_MESSAGE };
}

export interface VerifyResetResult {
  ticket: string;
}

/**
 * Step 2 — verify the code and mint a single-use reset ticket.
 * Returns null for a wrong/expired/consumed code with no distinction between
 * those cases (and no distinction between a missing account and a bad code).
 */
export async function verifyResetCode(rawEmail: string, rawCode: string): Promise<VerifyResetResult | null> {
  const secret = pepper();
  if (!secret) return null;
  const email = normaliseEmail(rawEmail);
  const code = rawCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  const db = getDb();
  const accountRows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const account = accountRows[0];
  if (!account || account.status !== "ACTIVE") return null;

  const rows = await db
    .select()
    .from(passwordResetChallenges)
    .where(
      and(
        eq(passwordResetChallenges.userId, account.id),
        isNull(passwordResetChallenges.consumedAt),
        isNull(passwordResetChallenges.verifiedAt),
        gt(passwordResetChallenges.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(passwordResetChallenges.createdAt))
    .limit(1);
  const challenge = rows[0];
  if (!challenge) return null;

  if (challenge.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
    await db
      .update(passwordResetChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(passwordResetChallenges.id, challenge.id));
    await auditSafely({
      user: null,
      action: "PASSWORD_RESET_FAILED",
      entityType: "USER",
      entityId: account.id,
      reason: "verification attempt limit reached",
    });
    return null;
  }

  const expected = hashCode(account.id, code, secret);
  const match = hexEqual(expected, challenge.codeHash);

  if (!match) {
    const attempts = challenge.attempts + 1;
    await db
      .update(passwordResetChallenges)
      .set({ attempts, ...(attempts >= PASSWORD_RESET_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) })
      .where(eq(passwordResetChallenges.id, challenge.id));
    if (attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      await auditSafely({
        user: null,
        action: "PASSWORD_RESET_FAILED",
        entityType: "USER",
        entityId: account.id,
        reason: "verification attempt limit reached",
      });
    }
    return null;
  }

  const ticket = randomBytes(32).toString("base64url");
  await db
    .update(passwordResetChallenges)
    .set({
      ticketHash: hashTicket(ticket),
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + TICKET_TTL_MS),
    })
    .where(eq(passwordResetChallenges.id, challenge.id));

  return { ticket };
}

export interface CompleteResetResult {
  userId: string;
}

/**
 * Step 3 — set the new password against a verified ticket. Reuses the existing
 * password policy and argon2id hashing; consumes the challenge; revokes every
 * session; audits. Throws ValidationError with a generic message when the ticket
 * is unknown, expired, or already used.
 */
export async function completePasswordReset(ticket: string, newPassword: string): Promise<CompleteResetResult> {
  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) {
    throw new ValidationError(
      `Password too weak: ${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")}`,
    );
  }
  if (typeof ticket !== "string" || ticket.length < 20) {
    throw new ValidationError("Invalid or expired reset request. Please start again.");
  }

  const passwordHash = await hashPassword(newPassword);

  const userId = await withTransaction(async (tx: Database) => {
    const rows = await tx
      .select()
      .from(passwordResetChallenges)
      .where(
        and(
          eq(passwordResetChallenges.ticketHash, hashTicket(ticket)),
          isNull(passwordResetChallenges.consumedAt),
          gt(passwordResetChallenges.expiresAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    const challenge = rows[0];
    if (!challenge || !challenge.verifiedAt) {
      throw new ValidationError("Invalid or expired reset request. Please start again.");
    }

    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, challenge.userId));

    // Retire this ticket and any other outstanding challenge for the account.
    await tx
      .update(passwordResetChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(eq(passwordResetChallenges.userId, challenge.userId), isNull(passwordResetChallenges.consumedAt)),
      );

    await audit(
      {
        user: { userId: challenge.userId },
        action: "PASSWORD_RESET_COMPLETED",
        entityType: "USER",
        entityId: challenge.userId,
        oldValue: { passwordReset: false, sessionsRevoked: false },
        newValue: { passwordReset: true, sessionsRevoked: true, mustChangePassword: false },
        reason: "self-service password reset completed",
      },
      tx,
    );

    return challenge.userId;
  });

  // After the transaction commits: a credential change invalidates every
  // existing session, exactly like the authenticated change-password flow.
  await revokeAllSessionsForUser(userId);
  return { userId };
}
