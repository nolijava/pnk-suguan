import { redirect } from "next/navigation";
import { requirePermission, requireUser } from "@/server/auth/guard";
import { hasPermission } from "@/server/auth/permissions";
import { UserManagementService } from "@/server/services";
import { userListQuerySchema } from "@/lib/validation/schemas";
import { UsersClient } from "./_components/users-client";

export const dynamic = "force-dynamic";

/**
 * Phase 10 — User Management (ADMIN-only). Non-authorized authenticated users
 * are redirected (never 404-ed) exactly like other admin-only pages.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!hasPermission(user.roleCodes, "users.manage")) redirect("/");
  await requirePermission("users.manage");

  const sp = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = userListQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : {};

  const rows = await UserManagementService.listUsers(query, user);

  return (
    <UsersClient
      initialRows={JSON.parse(JSON.stringify(rows))}
      filters={{ q: query.q ?? "", role: query.role ?? "", status: query.status ?? "" }}
      currentUserId={user.userId}
      currentUserRoles={user.roleCodes}
    />
  );
}
