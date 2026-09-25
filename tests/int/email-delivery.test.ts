/**
 * New Update #2 — password-reset email DELIVERY, proven end to end.
 *
 * The recovery pipeline was never broken in code: it failed closed because SMTP
 * had never been configured. The strongest proof available without a third-party
 * mailbox therefore has to involve a REAL SMTP conversation, not a stubbed
 * transport — so this suite runs a minimal SMTP server on loopback, points the
 * application's own configuration at it, and drives the whole flow:
 *
 *   request → code hashed + stored → email actually SENT → code read from the
 *   delivered message → verify → one-time ticket → reset → sign in with the new
 *   password.
 *
 * It also proves the negative direction (unconfigured ⇒ no transport, no
 * delivery, still the same generic answer) and that nothing about the code
 * reaches the logs when the developer echo is off.
 *
 * The captured message body stays in memory: no value is printed by the test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { eq } from "drizzle-orm";
import { resetTestDb, seedAdmin, teardown, db, sql } from "./helpers";
import * as schema from "@/server/db/schema";
import { isEmailConfigured, emailConfigurationProblem, sendTestEmail } from "@/server/auth/email";
import {
  requestPasswordReset,
  verifyResetCode,
  completePasswordReset,
  GENERIC_RESET_MESSAGE,
} from "@/server/auth/password-reset.service";
import { verifyPassword } from "@/server/auth/password";
import { getSessionUser } from "@/server/auth/session";

const PEPPER = "test-pepper-value-long-enough";
const EMAIL = "admin@test.local";
const NEW_PASSWORD = "BrandNewPass1!";

/** A minimal, real SMTP server: enough of RFC 5321 for nodemailer to talk to it. */
function startSmtpServer(): Promise<{ port: number; messages: string[]; server: Server }> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = "";
    const write = (line: string) => socket.write(`${line}\r\n`);
    write("220 pnk-test-smtp ESMTP ready");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = "";
            write("250 2.0.0 Ok: queued");
          } else {
            current += `${line}\n`;
          }
        } else {
          const verb = line.split(" ")[0]?.toUpperCase() ?? "";
          if (verb === "EHLO") {
            socket.write("250-pnk-test-smtp\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n");
          } else if (verb === "HELO") {
            write("250 pnk-test-smtp");
          } else if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") {
            write("250 2.1.0 Ok");
          } else if (verb === "DATA") {
            inData = true;
            write("354 End data with <CR><LF>.<CR><LF>");
          } else if (verb === "QUIT") {
            write("221 2.0.0 Bye");
            socket.end();
          } else {
            write("250 2.0.0 Ok");
          }
        }
        index = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, messages, server });
    });
  });
}

let smtp: Server;
let messages: string[];
let port: number;
let userId: string;
/** Carried between the flow cases so single-use can be proven on the real artifacts. */
let deliveredCode = "";
let deliveredTicket = "";

/**
 * The message arrives as a real MIME document: the subject is folded into
 * RFC 2047 encoded words (the em dash is not ASCII) and the body is
 * quoted-printable with soft line breaks. Decoding here keeps the assertions
 * about what a HUMAN would read, not about wire formatting.
 */
/** Turn `=XX` sequences into the bytes they stand for, one char per byte. */
function quotedPrintableBytes(text: string): string {
  return text.replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** An RFC 2047 encoded word: `_` is a space and `=XX` is a raw byte. */
function decodeWord(word: string): string {
  return quotedPrintableBytes(word.replace(/_/g, " "));
}

/**
 * Reassemble the bytes, then read them back as UTF-8 — the whole point is that
 * the human-readable text survives character sets and encodings.
 */
function decodeMessage(raw: string): string {
  const bytes = quotedPrintableBytes(
    raw
      .replace(/=\?utf-8\?q\?([\s\S]*?)\?=/gi, (_, word: string) => decodeWord(word))
      .replace(/\r?\n[ \t]+/g, "") // folded header continuation
      .replace(/=\r?\n/g, ""), // quoted-printable soft line breaks
  );
  return Buffer.from(bytes, "latin1").toString("utf8");
}

async function waitForMessage(match: (m: string) => boolean, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = messages.map(decodeMessage).find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no delivered message matched (received ${messages.length} message(s))`);
}

beforeAll(async () => {
  const started = await startSmtpServer();
  smtp = started.server;
  messages = started.messages;
  port = started.port;

  process.env.PNK_OTP_PEPPER = PEPPER;
  process.env.PNK_SMTP_HOST = "127.0.0.1";
  process.env.PNK_SMTP_PORT = String(port);
  process.env.PNK_SMTP_SECURE = "false";
  process.env.PNK_SMTP_FROM = "PNK Suguan <no-reply@test.local>";
  delete process.env.PNK_SMTP_URL;
  delete process.env.PNK_PASSWORD_RESET_DEV_ECHO;

  await resetTestDb();
  userId = await seedAdmin();
});

afterAll(async () => {
  delete process.env.PNK_SMTP_HOST;
  delete process.env.PNK_SMTP_PORT;
  delete process.env.PNK_SMTP_SECURE;
  delete process.env.PNK_SMTP_FROM;
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await teardown();
});

describe("email configuration is reported truthfully (never a secret)", () => {
  it("reports CONFIGURED and names no secret when SMTP is present", () => {
    expect(isEmailConfigured()).toBe(true);
    expect(emailConfigurationProblem()).toBeNull();
  });

  it("delivers a real test message whose content carries no code or credential", async () => {
    messages.length = 0;
    const result = await sendTestEmail(EMAIL);
    expect(result).toEqual({ delivered: true, problem: null });

    const body = await waitForMessage((m) => m.includes("delivery test from the PNK Suguan System"));
    expect(body).toContain("To: admin@test.local");
    expect(body).toContain("From: PNK Suguan <no-reply@test.local>");
    expect(body).toContain("Subject: PNK Suguan - email delivery test");
    expect(body).not.toMatch(/verification code is/i);
    // The transport's own credentials must never appear in the message.
    expect(body).not.toContain("PNK_SMTP");
    expect(body).not.toContain("127.0.0.1");
  });
});

describe("full recovery flow over a real SMTP conversation", () => {
  it("sends the code, verifies it, resets the password and signs the account in", async () => {
    messages.length = 0;
    await sql`DELETE FROM password_reset_challenges`;
    const ip = "10.9.9.1";

    // Nothing about the code may be logged: the developer echo is off, and both
    // console channels are watched for the rest of the flow.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const answer = await requestPasswordReset(EMAIL, ip);
      expect(answer.message).toBe(GENERIC_RESET_MESSAGE);

      const delivered = await waitForMessage((m) => m.includes("password reset verification code"));
      expect(delivered).toContain("To: admin@test.local");
      expect(delivered).toContain("Subject: PNK Suguan \u2014 password reset verification code");
      const code = /Your verification code is: (\d{6})/.exec(delivered)?.[1];
      expect(code, "the delivered message must contain a 6-digit code").toBeTruthy();
      deliveredCode = code!;

      // The code is stored only as a hash — never in plaintext.
      const rows = await db
        .select()
        .from(schema.passwordResetChallenges)
        .where(eq(schema.passwordResetChallenges.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.codeHash).not.toContain(code!);
      expect(JSON.stringify(rows[0])).not.toContain(code!);

      const verified = await verifyResetCode(EMAIL, code!);
      expect(verified?.ticket).toBeTruthy();
      deliveredTicket = verified!.ticket;

      await completePasswordReset(verified!.ticket, NEW_PASSWORD);
      const userRow = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!;
      expect(await verifyPassword(userRow.passwordHash, NEW_PASSWORD)).toBe(true);
      expect(userRow.mustChangePassword).toBe(false);

      // A session created AFTER the reset authenticates the account again.
      const { createSession } = await import("@/server/auth/session");
      const { token } = await createSession(userId);
      expect((await getSessionUser(token))?.userId).toBe(userId);
    } finally {
      infoSpy.mockRestore();
      logSpy.mockRestore();
    }

    const logged = [...infoSpy.mock.calls, ...logSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(logged).not.toMatch(/verification code for/);
    expect(logged).not.toMatch(/\d{6}/);
  });

  it("makes the delivered code and its ticket single-use", async () => {
    // Both artifacts came out of the REAL message the mail server received.
    expect(deliveredCode).toMatch(/^\d{6}$/);
    expect(deliveredTicket.length).toBeGreaterThan(20);

    // The consumed challenge cannot be verified again…
    expect(await verifyResetCode(EMAIL, deliveredCode)).toBeNull();
    // …and its ticket cannot reset the password a second time.
    await expect(completePasswordReset(deliveredTicket, "AnotherPass1!")).rejects.toThrow();

    // The password is still the one chosen during the legitimate reset.
    const userRow = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]!;
    expect(await verifyPassword(userRow.passwordHash, NEW_PASSWORD)).toBe(true);

    const rows = await db
      .select()
      .from(schema.passwordResetChallenges)
      .where(eq(schema.passwordResetChallenges.userId, userId));
    // Every challenge for the account is retired after completion.
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);
  });
});

describe("unconfigured email fails closed and stays invisible to the caller", () => {
  it("reports NOT CONFIGURED, delivers nothing, and still answers generically", async () => {
    const host = process.env.PNK_SMTP_HOST;
    delete process.env.PNK_SMTP_HOST;
    try {
      expect(isEmailConfigured()).toBe(false);
      expect(emailConfigurationProblem()).toBeTruthy();

      messages.length = 0;
      const test = await sendTestEmail(EMAIL);
      expect(test.delivered).toBe(false);
      expect(test.problem).toBeTruthy();

      await sql`DELETE FROM password_reset_challenges`;
      const answer = await requestPasswordReset(EMAIL, "10.9.9.2");
      expect(answer.message).toBe(GENERIC_RESET_MESSAGE);
      await new Promise((r) => setTimeout(r, 300));
      expect(messages).toHaveLength(0);
    } finally {
      process.env.PNK_SMTP_HOST = host;
    }
  });
});
