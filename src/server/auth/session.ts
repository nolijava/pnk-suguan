import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions, users, userRoles, roles } from "@/server/db/schema";
import { permissionsForRoles, type Permission } from "./permissions";
import { UnauthorizedError } from "@/lib/errors";

const SESSION_TTL_MS = 12 * 3600 * 1000; // 12 hours
export const SESSION_COOKIE = "pnk_session";

export interface SessionUser {
  userId: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
  roleCodes: string[];
  permissions: Permission[];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = getDb();
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        isNull(sessions.revokedAt),
        eq(users.status, "ACTIVE"),
      ),
    )
    .limit(1);
  const user = rows[0]?.user;
  if (!user) return null;
  const roleRows = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, user.id));
  const roleCodes = roleRows.map((r) => r.code);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    roleCodes,
    permissions: permissionsForRoles(roleCodes),
  };
}

export async function revokeSession(token: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export { UnauthorizedError };
