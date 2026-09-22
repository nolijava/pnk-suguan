import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { TeacherService } from "@/server/services";
import { reasonQuerySchema } from "@/lib/validation/query-schemas";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePermission("teachers.read");
    const { id } = await params;
    return ok(await TeacherService.getTeacher(id));
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("teachers.write");
    const { id } = await params;
    const body = await parseBody<Record<string, unknown>>(req);
    return ok(await TeacherService.updateTeacher(id, body, user));
  } catch (err) {
    return fail(err);
  }
}

/** DELETE = soft deactivation (never a physical delete; §14/§29). */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("teachers.write");
    const { id } = await params;
    // A missing or blank `reason` is the caller's error (400), not the
    // sanitized 500 this used to return.
    const { reason } = parseQuery(req, reasonQuerySchema);
    return ok(await TeacherService.deactivateTeacher(id, reason, user));
  } catch (err) {
    return fail(err);
  }
}
