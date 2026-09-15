import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { users, roles, userRoles } from "@/server/db/schema";
import { hashPassword } from "./password";
import { checkPasswordStrength } from "@/lib/password-strength";

/**
 * Creates the initial Administrator exactly once.
 * - Email comes from INITIAL_ADMIN_EMAIL (a value you control, not an authorization rule).
 * - Password comes ONLY from INITIAL_ADMIN_PASSWORD or INITIAL_ADMIN_PASSWORD_FILE.
 * - The ADMIN role is granted via the user_roles role system.
 * - must_change_password is enforced so the first login rotates the secret.
 */
export async function bootstrapInitialAdmin(): Promise<{ created: boolean; email: string }> {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("INITIAL_ADMIN_EMAIL is not set");

  let password = process.env.INITIAL_ADMIN_PASSWORD;
  const pwFile = process.env.INITIAL_ADMIN_PASSWORD_FILE;
  if (!password && pwFile) password = (await readFile(pwFile, "utf8")).trim();
  if (!password) {
    throw new Error("Provide INITIAL_ADMIN_PASSWORD or INITIAL_ADMIN_PASSWORD_FILE");
  }

  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    throw new Error(`Initial admin password too weak: ${strength.checks.filter(c=>!c.ok).map(c=>c.rule).join("; ")}`);
  }

  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { created: false, email }; // idempotent — never duplicates, never overwrites
  }

  const adminRole = await db.select().from(roles).where(eq(roles.code, "ADMIN")).limit(1);
  if (adminRole.length === 0) throw new Error("ADMIN role missing — run migrations first");

  const passwordHash = await hashPassword(password);
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ email, passwordHash, fullName: "Initial Administrator", mustChangePassword: true })
      .returning();
    const user = inserted[0]!;
    await tx.insert(userRoles).values({ userId: user.id, roleId: adminRole[0]!.id });
    return user;
  });

  return { created: true, email: created.email };
}
