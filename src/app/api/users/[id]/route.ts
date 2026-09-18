import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { UserManagementService } from "@/server/services";
import { userPatchSchema } from "@/lib/validation/schemas";
import { ValidationError } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePermission("users.manage");
    const { id } = await params;
    return ok(await UserManagementService.getUser(id));
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const actor = await requirePermission("users.manage");
    const { id } = await params;
    const body = userPatchSchema.parse(await parseBody(req));
    if (body.action === "profile") {
      return ok(await UserManagementService.updateUserProfile(id, body.fullName, actor));
    }
    if (body.action === "role") {
      return ok(
        await UserManagementService.changeUserRole(id, body.roleCode, actor, body.reason),
      );
    }
    if (body.action === "status") {
      return ok(
        await UserManagementService.changeUserStatus(id, body.status, actor, body.reason),
      );
    }
    throw new ValidationError("Unsupported action");
  } catch (err) {
    return fail(err);
  }
}
