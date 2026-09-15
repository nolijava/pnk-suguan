import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("assignments.write");
    const { id } = await params;
    const body = await parseBody<{ teacherId?: string; assignmentType?: string; reason: string }>(req);
    return ok(await AssignmentService.changeAssignment(id, body, user));
  } catch (err) {
    return fail(err);
  }
}
