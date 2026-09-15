import { ok, fail } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.counts.read");
    const url = new URL(req.url);
    const rows = await AssignmentService.getAssignmentCounts({
      teacherId: url.searchParams.get("teacherId") ?? undefined,
      dakoId: url.searchParams.get("dakoId") ?? undefined,
      assignmentType: url.searchParams.get("assignmentType") ?? undefined,
    });
    return ok(rows);
  } catch (err) {
    return fail(err);
  }
}
