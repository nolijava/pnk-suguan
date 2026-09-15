import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { verifyPassword, hashPassword } from "./password";
import { createSession, revokeSession, revokeAllSessionsForUser } from "./session";
import { checkPasswordStrength } from "@/lib/password-strength";
import { UnauthorizedError, ValidationError } from "@/lib/errors";

export interface LoginResult {
  token: string;
  expiresAt: Date;
  mustChangePassword: boolean;
  userId: string;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  const user = rows[0];
  // Uniform error — never reveal whether the email exists.
  if (!user || user.status !== "ACTIVE") throw new UnauthorizedError("Invalid credentials");
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) throw new UnauthorizedError("Invalid credentials");

  const { token, expiresAt } = await createSession(user.id);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { token, expiresAt, mustChangePassword: user.mustChangePassword, userId: user.id };
}

export async function logout(token: string): Promise<void> {
  await revokeSession(token);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new UnauthorizedError();

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) throw new ValidationError("Current password is incorrect");

  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) {
    throw new ValidationError(`Password too weak: ${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")}`);
  }

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
    .where(eq(users.id, userId));
  // Force re-authentication everywhere after a credential change.
  await revokeAllSessionsForUser(userId);
}
