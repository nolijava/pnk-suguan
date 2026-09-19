/**
 * Operator escape hatch: reset the password of a SUPER_ADMIN account directly
 * in the database. This exists because the application's reset-password path
 * correctly refuses to touch SUPER_ADMIN rows unless the actor is also a
 * SUPER_ADMIN (safeguard S3) — so a lost SUPER_ADMIN password would otherwise
 * be unrecoverable.
 *
 * Scope guard: refuses to run against any account that does not hold the
 * SUPER_ADMIN role. For normal accounts, use the /users UI.
 *
 * What it does:
 *  - generates a random temporary password (CSPRNG) and prints it ONCE
 *  - hashes it with the project argon2id module
 *  - sets must_change_password = true (rotation forced at next login)
 *  - revokes all of the account's active sessions
 *  - writes an audit row (RESET_USER_PASSWORD) in the same transaction —
 *    the temporary secret itself is never stored or logged
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/reset-super-admin.ts --email super.admin@pnk.local [--database-url <url>]
 */
import { randomBytes } from "node:crypto";
import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb } from "../src/server/db/lifecycle";
import { getDb } from "../src/server/db/client";
import { roles, sessions, userRoles, users } from "@/server/db/schema";
import { hashPassword } from "../src/server/auth/password";
import { audit } from "../src/server/services/audit.service";

// Unambiguous alphabet (no 0/O/1/l/I) — safe to read aloud or transcribe.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

function generateTempPassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const email = argValue("--email");
  if (!email) {
    console.error("[reset-super-admin] --email is required");
    process.exit(1);
  }

  const db = getDb();
  const tempPassword = generateTempPassword();

  try {
    const result = await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!target) {
        throw new Error(`no user found with email ${email}`);
      }

      const [grant] = await tx
        .select({ code: roles.code })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.userId, target.id), eq(roles.code, "SUPER_ADMIN")))
        .limit(1);

      if (!grant) {
        throw new Error(
          `${email} does not hold the SUPER_ADMIN role — this script only resets SUPER_ADMIN accounts (use the /users UI for normal accounts)`,
        );
      }

      if (target.status !== "ACTIVE") {
        throw new Error(`${email} is ${target.status}; reactivate it first via the /users UI`);
      }

      const passwordHash = await hashPassword(tempPassword);

      await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
        .where(eq(users.id, target.id));

      await audit(
        {
          user: null, // console operator, not an authenticated session
          action: "RESET_USER_PASSWORD",
          entityType: "USER",
          entityId: target.id,
          oldValue: null,
          newValue: { mustChangePassword: true, via: "scripts/reset-super-admin.ts" },
          reason: "Operator password reset for SUPER_ADMIN account (escape-hatch script)",
        },
        tx as unknown as Parameters<typeof audit>[1],
      );

      return target;
    });

    // Idempotent cleanup after commit: kill every live session for the account.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, result.id), isNull(sessions.revokedAt)));

    console.log(`[reset-super-admin] password reset for ${result.email}`);
    console.log(`[reset-super-admin] must_change_password = true (rotation forced at next login)`);
    console.log(`[reset-super-admin] all active sessions revoked`);
    console.log(`[reset-super-admin] audit row written (RESET_USER_PASSWORD)`);
    console.log("");
    console.log("  TEMPORARY PASSWORD (shown once — store it in a password manager):");
    console.log(`  ${tempPassword}`);
    console.log("");
    console.log("  Sign in with this once; the app will force a new password.");
  } finally {
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(`[reset-super-admin] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
