import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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

// ---------------------------------------------------------------------------
// Page/layout variants. Next.js renders a route's layout.tsx and page.tsx
// CONCURRENTLY (the page is passed to the layout as an already-rendered slot),
// so on an expired/revoked session the page's raw UnauthorizedError used to win
// the race against the layout's try/catch redirect — surfacing a stack-trace
// error page (dev overlay / 500) instead of the login screen. These wrappers
// convert "not authenticated" into a /login redirect from whichever side hits
// it first. Route handlers keep requireUser/requirePermission above for the
// 401/403 JSON contract.
// ---------------------------------------------------------------------------

export async function requirePageUser(): Promise<SessionUser> {
  try {
    return await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    throw err;
  }
}

export async function requirePagePermission(permission: Permission): Promise<SessionUser> {
  try {
    return await requirePermission(permission);
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    throw err;
  }
}
