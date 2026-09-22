/**
 * Operator provisioning tool: create — or rotate — a SUPER_ADMIN account.
 *
 * Why a script: there is deliberately NO application path that grants SUPER_ADMIN.
 * Create/Edit User offer only ADMIN / SCHEDULER / VIEWER, and docs/setup.md records
 * that SUPER_ADMIN is provisioned by an operator directly against the database.
 * This file implements exactly that documented procedure:
 *
 *   1. create the account with a one-time argon2id password
 *   2. insert the `user_roles` row for the SUPER_ADMIN role
 *   3. write an audit row (`GRANTED_SUPER_ADMIN`)
 *
 * Hashing and audit conventions mirror scripts/reset-super-admin.ts.
 *
 * Behaviour:
 *   - new email        -> creates the account (must_change_password = true),
 *                         grants SUPER_ADMIN, audited GRANTED_SUPER_ADMIN
 *   - existing email   -> rotates the one-time password, re-forces rotation,
 *                         ensures the SUPER_ADMIN grant, revokes sessions,
 *                         audited RESET_USER_PASSWORD
 *   - INACTIVE account -> refuses, matching scripts/reset-super-admin.ts
 *                         (reactivate via the /users UI first)
 *
 * The generated one-time password satisfies the application policy (>=10 chars,
 * upper, lower, digit, symbol) and is printed exactly ONCE. It is never stored
 * in the database, never written to an audit row, and never returned by any API.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/provision-super-admin.ts \
 *     [--email super.admin@pnk.local] [--database-url <url>]
 */
import { randomInt } from "node:crypto";
import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { checkPasswordStrength } from "../src/lib/password-strength";
import { hashPassword } from "../src/server/auth/password";
import { getDb } from "../src/server/db/client";
import { closeDb } from "../src/server/db/lifecycle";
import { roles, sessions, userRoles, users } from "@/server/db/schema";
import { audit } from "../src/server/services/audit.service";

const DEFAULT_EMAIL = "super.admin@pnk.local";
const FULL_NAME = "Super Administrator";

// Unambiguous alphabet (no 0/O/1/l/I) — safe to read aloud or transcribe.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*_-+=";

/** Uniformly index into `set` using the CSPRNG (no modulo bias concerns for OTP). */
function pick(set: string): string {
  return set[randomInt(set.length)]!;
}

/**
 * One-time password that already satisfies the app policy, so it is not rejected
 * if the operator inspects it through a strength-checked path: at least one upper,
 * one lower, one digit and one symbol, then padded and CSPRNG-shuffled.
 */
function generateOneTimePassword(length = 20): string {
  const chars: string[] = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALPHABET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  const password = chars.join("");
  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    // Unreachable given the construction above; fail loudly rather than ship a
    // weak credential if the policy ever changes.
    throw new Error(
      `generated password failed the policy (${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")})`,
    );
  }
  return password;
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const email = (argValue("--email") ?? DEFAULT_EMAIL).trim().toLowerCase();
  const databaseUrl = argValue("--database-url");
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

  const db = getDb();
  const oneTimePassword = generateOneTimePassword();

  try {
    const outcome = await db.transaction(async (tx) => {
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, "SUPER_ADMIN"))
        .limit(1);
      if (!role) throw new Error("SUPER_ADMIN role missing — run migrations first");

      const [existing] = await tx
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing && existing.status !== "ACTIVE") {
        throw new Error(
          `${email} is ${existing.status}; reactivate it first via the /users UI (the script will not silently reactivate an account)`,
        );
      }

      const passwordHash = await hashPassword(oneTimePassword);

      if (!existing) {
        const inserted = await tx
          .insert(users)
          .values({ email, passwordHash, fullName: FULL_NAME, mustChangePassword: true })
          .returning();
        const user = inserted[0]!;

        await tx.insert(userRoles).values({ userId: user.id, roleId: role.id });

        await audit(
          {
            user: null, // console operator, not an authenticated session
            action: "GRANTED_SUPER_ADMIN",
            entityType: "USER",
            entityId: user.id,
            oldValue: null,
            newValue: { email, roles: ["SUPER_ADMIN"], mustChangePassword: true, via: "scripts/provision-super-admin.ts" },
            reason: "Operator provisioning of a SUPER_ADMIN account (no application path grants this role)",
          },
          tx as unknown as Parameters<typeof audit>[1],
        );

        return { created: true, id: user.id, email: user.email, grantedRole: true };
      }

      await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
        .where(eq(users.id, existing.id));

      // Ensure the grant exists (a rotate on a non-SUPER_ADMIN row must not
      // silently promote it without its own audit row).
      const [grant] = await tx
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(and(eq(userRoles.userId, existing.id), eq(userRoles.roleId, role.id)))
        .limit(1);

      let grantedRole = false;
      if (!grant) {
        await tx.insert(userRoles).values({ userId: existing.id, roleId: role.id });
        grantedRole = true;
        await audit(
          {
            user: null,
            action: "GRANTED_SUPER_ADMIN",
            entityType: "USER",
            entityId: existing.id,
            oldValue: null,
            newValue: { email, roles: ["SUPER_ADMIN"], via: "scripts/provision-super-admin.ts" },
            reason: "Operator granted SUPER_ADMIN to an existing account",
          },
          tx as unknown as Parameters<typeof audit>[1],
        );
      }

      await audit(
        {
          user: null,
          action: "RESET_USER_PASSWORD",
          entityType: "USER",
          entityId: existing.id,
          oldValue: null,
          newValue: { mustChangePassword: true, via: "scripts/provision-super-admin.ts" },
          reason: "Operator issued a one-time password for the SUPER_ADMIN account",
        },
        tx as unknown as Parameters<typeof audit>[1],
      );

      return { created: false, id: existing.id, email: existing.email, grantedRole };
    });

    // Idempotent cleanup after commit: kill every live session for the account.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, outcome.id), isNull(sessions.revokedAt)));

    console.log(`[provision-super-admin] ${outcome.created ? "created" : "rotated"} ${outcome.email}`);
    console.log(`[provision-super-admin] SUPER_ADMIN role: ${outcome.grantedRole ? "granted" : "already held"}`);
    console.log(`[provision-super-admin] must_change_password = true (rotation forced at next login)`);
    console.log(`[provision-super-admin] all active sessions revoked`);
    console.log(
      `[provision-super-admin] audit rows written (${outcome.created ? "GRANTED_SUPER_ADMIN" : "RESET_USER_PASSWORD"}${
        !outcome.created && outcome.grantedRole ? " + GRANTED_SUPER_ADMIN" : ""
      })`,
    );
    console.log("");
    console.log("  ONE-TIME PASSWORD (shown once — store it in a password manager):");
    console.log(`  ${oneTimePassword}`);
    console.log("");
    console.log("  Sign in with this once; the app will force a new password.");
    console.log("  Re-run this script at any time to rotate the one-time password.");
  } finally {
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(`[provision-super-admin] FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
