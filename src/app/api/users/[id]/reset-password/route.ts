import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { UserManagementService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

/**
 * One-time password reset. The temporary password is returned exactly once in
 * this response (HTTPS-only in production), never stored in clear, never
 * logged — the audit entry records only that a reset happened. All of the
 * target's sessions are revoked.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const actor = await requirePermission("users.manage");
    const { id } = await params;
    return ok(await UserManagementService.resetUserPassword(id, actor));
  } catch (err) {
    return fail(err);
  }
}
