import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import { assignmentCountsQuerySchema } from "@/lib/validation/query-schemas";

export async function GET(req: Request) {
  try {
    await requirePermission("assignments.counts.read");
    // Filters stay optional, but a supplied one must be well-formed: a non-uuid
    // id or an unknown assignment type used to reach the query planner and
    // surface as a sanitized 500.
    const query = parseQuery(req, assignmentCountsQuerySchema);
    const rows = await AssignmentService.getAssignmentCounts({
      teacherId: query.teacherId,
      dakoId: query.dakoId,
      assignmentType: query.assignmentType,
    });
    return ok(rows);
  } catch (err) {
    return fail(err);
  }
}
