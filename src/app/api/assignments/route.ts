import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import type { AssignmentCreateInput } from "@/lib/validation/schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    const url = new URL(req.url);
    const weekId = url.searchParams.get("weekId");
    if (!weekId) return fail(new Error("weekId query param is required"));
    return ok(await AssignmentService.listAssignmentsForWeek(weekId));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePermission("assignments.write");
    const body = await parseBody<AssignmentCreateInput>(req);
    const result = await AssignmentService.createAssignment(body, user);
    return ok(result, 201);
  } catch (err) {
    return fail(err);
  }
}
