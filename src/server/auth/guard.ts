import { cookies } from "next/headers";
import { SESSION_COOKIE, getSessionUser, type SessionUser } from "./session";
import { hasPermission } from "./permissions";
import type { Permission } from "./permissions";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";

/** Resolve the authenticated user from the session cookie. Throws 401 if absent. */
export async function requireUser(): Promise<SessionUser> {
  const store = await cookies();
  const user = await getSessionUser(store.get(SESSION_COOKIE)?.value);
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Require a specific permission; throws 401/403 as appropriate. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasPermission(user.roleCodes, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
  return user;
}

export async function currentUserOrNull(): Promise<SessionUser | null> {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value);
}
