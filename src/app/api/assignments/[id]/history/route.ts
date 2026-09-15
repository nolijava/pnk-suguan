import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePermission("assignments.history.read");
    const { id } = await params;
    return ok(await AssignmentService.getAssignmentHistory(id));
  } catch (err) {
    return fail(err);
  }
}
