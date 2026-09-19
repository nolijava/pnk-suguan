/**
 * Group 1 — forgot-password / account recovery integration tests.
 *
 * Covers the whole approved contract:
 *   • no account enumeration (identical result for known / unknown / inactive,
 *     and when rate-limited)
 *   • CSPRNG code stored ONLY as a peppered HMAC (never plaintext), 10-minute
 *     expiry, single-use, 5-attempt cap, 60s resend cooldown, per-account and
 *     per-IP hour caps (DB-backed)
 *   • one-time reset ticket: scoped to the account, single-use, expires
 *   • completion reuses the existing argon2id hashing, clears must_change_password,
 *     revokes every session, audits, and leaks no secret material anywhere
 *   • fail-closed when the pepper or SMTP is not configured
 *   • the flow never touches scheduling tables (read-only with respect to them)
 *
 * The verification code is never returned by any production path, so the test
 * uses the approved developer opt-in (`PNK_PASSWORD_RESET_DEV_ECHO`) purely as a
 * TEST SEAM: it writes the code to the server console, which the test captures.
 * A dedicated case proves the same call logs NOTHING once the flag is off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import {
  requestPasswordReset,
  verifyResetCode,
  completePasswordReset,
  GENERIC_RESET_MESSAGE,
  PASSWORD_RESET_MAX_ATTEMPTS,
} from "@/server/auth/password-reset.service";
import { sendPasswordResetCode, isEmailConfigured, passwordResetDevEchoEnabled } from "@/server/auth/email";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, getSessionUser } from "@/server/auth/session";

const PEPPER = "test-pepper-value-long-enough";
// seedAdmin() provisions admin@test.local — the recovery flow under test targets
// that real account.
const EMAIL = "admin@test.local";
const UNKNOWN_EMAIL = "nobody-here@test.local";
const PASSWORD = "OriginalPass1!";

let userId: string;

/** Capture the code from the approved dev echo (test seam). */
async function requestAndCaptureCode(email: string, ip = "10.0.0.1"): Promise<string> {
  const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  try {
    await requestPasswordReset(email, ip);
    // The email send is fire-and-forget; wait briefly for the echo.
    for (let i = 0; i < 40; i++) {
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("verification code for"));
      if (line) {
        const code = line.split(": ").pop()?.trim();
        if (code) return code;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("code was not echoed (dev flag off?)");
  } finally {
    spy.mockRestore();
  }
}

async function challengeRows() {
  return db.select().from(schema.passwordResetChallenges).where(eq(schema.passwordResetChallenges.userId, userId));
}

beforeAll(async () => {
  process.env.PNK_OTP_PEPPER = PEPPER;
  process.env.PNK_PASSWORD_RESET_DEV_ECHO = "true";
  delete process.env.PNK_SMTP_URL;
  delete process.env.PNK_SMTP_HOST;
  await resetTestDb();
  userId = await seedAdmin();
});

afterAll(async () => {
  delete process.env.PNK_PASSWORD_RESET_DEV_ECHO;
  await teardown();
});

beforeEach(async () => {
  // Clear challenges and reset the account between cases (rate limits are
  // derived from these rows, so this is also how each case starts un-throttled).
  await sql`DELETE FROM password_reset_challenges`;
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD), mustChangePassword: true })
    .where(eq(schema.users.id, userId));
});

describe("request step — no enumeration, no plaintext", () => {
  it("answers identically for a known, an unknown and an inactive address", async () => {
    const known = await requestPasswordReset(EMAIL, "10.1.0.1");
    const unknown = await requestPasswordReset(UNKNOWN_EMAIL, "10.1.0.2");
    await db.update(schema.users).set({ status: "INACTIVE" }).where(eq(schema.users.id, userId));
    const inactive = await requestPasswordReset(EMAIL, "10.1.0.3");
    await db.update(schema.users).set({ status: "ACTIVE" }).where(eq(schema.users.id, userId));

    for (const r of [known, unknown, inactive]) {
      expect(r.message).toBe(GENERIC_RESET_MESSAGE);
    }
  });

  it("creates exactly one challenge for the account and never stores the code in plaintext", async () => {
    await sql`DELETE FROM password_reset_challenges`;
    const code = await requestAndCaptureCode(EMAIL);
    const rows = await challengeRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toHaveLength(64); // HMAC-SHA256 hex
    expect(row.ticketHash).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.consumedAt).toBeNull();
    // ~10 minutes, never indefinite.
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 2000);
  });

  it("rate-limits resends: a second request inside the cooldown adds no row", async () => {
    await requestAndCaptureCode(EMAIL);
    await requestPasswordReset(EMAIL, "10.2.0.1");
    expect(await challengeRows()).toHaveLength(1);
  });

  it("caps sends per account per hour", async () => {
    // Three challenges inside the hour, then two more attempts that must be refused.
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.passwordResetChallenges).values({
        userId,
        codeHash: "x".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        requestedIp: `10.9.0.${i}`,
      });
    }
    const before = (await challengeRows()).length;
    const result = await requestPasswordReset(EMAIL, "10.9.9.9");
    expect(result.message).toBe(GENERIC_RESET_MESSAGE);
    expect((await challengeRows()).length).toBe(before);
  });

  it("caps sends per IP across accounts", async () => {
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.passwordResetChallenges).values({
        userId,
        codeHash: "y".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        requestedIp: "203.0.113.7",
      });
    }
    const before = (await challengeRows()).length;
    await requestPasswordReset(EMAIL, "203.0.113.7");
    expect((await challengeRows()).length).toBe(before); // no new send
  });

  it("retiring the previous challenge: a new send invalidates the old one", async () => {
    await requestAndCaptureCode(EMAIL);
    const first = (await challengeRows())[0]!;
    // Clear the cooldown clock by backdating the first row.
    await db
      .update(schema.passwordResetChallenges)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.passwordResetChallenges.id, first.id));
    await requestPasswordReset(EMAIL, "10.3.0.1");
    const rows = await challengeRows();
    const live = rows.filter((r) => r.consumedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(first.id);
  });

  it("fails closed with no pepper and still answers generically", async () => {
    const saved = process.env.PNK_OTP_PEPPER;
    delete process.env.PNK_OTP_PEPPER;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await requestPasswordReset(EMAIL, "10.4.0.1");
      expect(result.message).toBe(GENERIC_RESET_MESSAGE);
      expect(await challengeRows()).toHaveLength(0);
      expect(spy.mock.calls.map((c) => String(c[0])).join(" ")).toContain("PNK_OTP_PEPPER");
    } finally {
      process.env.PNK_OTP_PEPPER = saved;
      spy.mockRestore();
    }
  });
});

describe("verify step — attempts, expiry, single use", () => {
  it("rejects a wrong code and counts the attempt", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifyResetCode(EMAIL, wrong)).toBeNull();
    expect((await challengeRows())[0]!.attempts).toBe(1);
  });

  it("rejects a malformed code without touching the counter", async () => {
    await requestAndCaptureCode(EMAIL);
    expect(await verifyResetCode(EMAIL, "12ab")).toBeNull();
    expect((await challengeRows())[0]!.attempts).toBe(0);
  });

  it("invalidates the challenge at the attempt cap and audits the failure", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    const wrong = String((Number(code) + 7919) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < PASSWORD_RESET_MAX_ATTEMPTS; i++) {
      await verifyResetCode(EMAIL, wrong);
    }
    const row = (await challengeRows())[0]!;
    expect(row.attempts).toBeGreaterThanOrEqual(PASSWORD_RESET_MAX_ATTEMPTS);
    expect(row.consumedAt).not.toBeNull();
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "PASSWORD_RESET_FAILED"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("rejects an expired code", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    await db
      .update(schema.passwordResetChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.passwordResetChallenges.userId, userId));
    expect(await verifyResetCode(EMAIL, code)).toBeNull();
  });

  it("rejects verification for an unknown address", async () => {
    expect(await verifyResetCode(UNKNOWN_EMAIL, "123456")).toBeNull();
  });

  it("mints a ticket for the correct code and marks the challenge verified", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    const result = await verifyResetCode(EMAIL, code);
    expect(result?.ticket).toBeTruthy();
    const row = (await challengeRows())[0]!;
    expect(row.ticketHash).not.toBeNull();
    expect(row.ticketHash).not.toContain(result!.ticket);
    expect(row.verifiedAt).not.toBeNull();
  });

  it("does not accept the code twice", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    expect(await verifyResetCode(EMAIL, code)).not.toBeNull();
    expect(await verifyResetCode(EMAIL, code)).toBeNull();
  });
});

describe("complete step — policy, hashing, sessions, audit", () => {
  it("rejects a weak password and leaves the credential untouched", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    const { ticket } = (await verifyResetCode(EMAIL, code))!;
    await expect(completePasswordReset(ticket, "weak")).rejects.toThrow(/too weak/i);
    const row = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!;
    expect(await verifyPassword(row.passwordHash, PASSWORD)).toBe(true);
  });

  it("rejects an unknown or already-consumed ticket with a generic message", async () => {
    await expect(completePasswordReset("not-a-real-ticket-value-abcdefghij", "NewStrongPass1!")).rejects.toThrow(
      /Invalid or expired reset request/,
    );
  });

  it("rejects an expired ticket", async () => {
    const code = await requestAndCaptureCode(EMAIL);
    const { ticket } = (await verifyResetCode(EMAIL, code))!;
    await db
      .update(schema.passwordResetChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.passwordResetChallenges.userId, userId));
    await expect(completePasswordReset(ticket, "NewStrongPass1!")).rejects.toThrow(/Invalid or expired/);
  });

  it("resets the password, clears the forced rotation, revokes sessions and audits once", async () => {
    const { token } = await createSession(userId);
    expect(await getSessionUser(token)).not.toBeNull();

    const code = await requestAndCaptureCode(EMAIL);
    const { ticket } = (await verifyResetCode(EMAIL, code))!;
    const NEW_PASSWORD = "BrandNewPass2!";
    await completePasswordReset(ticket, NEW_PASSWORD);

    const row = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!;
    expect(await verifyPassword(row.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row.passwordHash, PASSWORD)).toBe(false);
    expect(row.mustChangePassword).toBe(false);

    // Every existing session is dead, including the one created above.
    expect(await getSessionUser(token)).toBeNull();

    // Single use: the ticket cannot be replayed.
    await expect(completePasswordReset(ticket, "AnotherPass3!")).rejects.toThrow(/Invalid or expired/);

    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "PASSWORD_RESET_COMPLETED"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(userId);
  });

  it("never writes the code, ticket or new password into an audit row", async () => {
    const NEW_PASSWORD = "SecretPass4!";
    const code = await requestAndCaptureCode(EMAIL);
    const { ticket } = (await verifyResetCode(EMAIL, code))!;
    await completePasswordReset(ticket, NEW_PASSWORD);

    const rows = await db.select().from(schema.auditLogs);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(ticket);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(PEPPER);
  });
});

describe("email transport and dev echo", () => {
  it("reports not-configured and never throws when SMTP is absent", async () => {
    expect(isEmailConfigured()).toBe(false);
    const result = await sendPasswordResetCode({
      to: "x@test.local",
      fullName: "X",
      code: "123456",
      expiresInMinutes: 10,
    });
    expect(result.delivered).toBe(false);
  });

  it("disables the dev echo in production regardless of the flag", () => {
    vi.stubEnv("PNK_PASSWORD_RESET_DEV_ECHO", "true");
    // vitest runs with NODE_ENV=test → the explicit opt-in is honoured here…
    expect(passwordResetDevEchoEnabled()).toBe(true);
    // …and hard-disabled the moment NODE_ENV is production.
    vi.stubEnv("NODE_ENV", "production");
    expect(passwordResetDevEchoEnabled()).toBe(false);
    vi.unstubAllEnvs();
    process.env.PNK_PASSWORD_RESET_DEV_ECHO = "true";
  });

  it("logs nothing at all when the dev flag is off", async () => {
    const saved = process.env.PNK_PASSWORD_RESET_DEV_ECHO;
    delete process.env.PNK_PASSWORD_RESET_DEV_ECHO;
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await sendPasswordResetCode({ to: "x@test.local", fullName: "X", code: "654321", expiresInMinutes: 10 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.PNK_PASSWORD_RESET_DEV_ECHO = saved;
      spy.mockRestore();
    }
  });
});

describe("read-only with respect to scheduling data", () => {
  it("a full recovery leaves weeks/assignments/availability untouched", async () => {
    const counts = async () => {
      const n = async (table: string) => {
        const rows = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
        return rows[0]!.n;
      };
      return {
        weeks: await n("weeks"),
        assignments: await n("assignments"),
        availability: await n("teacher_availability"),
        history: await n("assignment_history"),
      };
    };
    const before = await counts();
    const code = await requestAndCaptureCode(EMAIL);
    const { ticket } = (await verifyResetCode(EMAIL, code))!;
    await completePasswordReset(ticket, "ReadOnlyPass5!");
    expect(await counts()).toEqual(before);
  });
});
