import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";
import { slotCandidatesQuerySchema } from "@/lib/validation/query-schemas";

/**
 * Master plan §19/§21/§22 — server-computed candidate list for one
 * week+dako+type slot. Eligible-only for normal Delegate/Override; the
 * `unavailable` list (with exact violated rules) is displayed only by the
 * ADMIN exception mode and can never be selected through the normal path.
 */
export async function GET(req: Request) {
  try {
    await requirePermission("assignments.read");
    // A malformed slot selection is the caller's error (400). This used to
    // `fail(new Error("invalid query"))`, i.e. the sanitized 500.
    const { weekId, dakoId, assignmentType, assignmentId } = parseQuery(req, slotCandidatesQuerySchema);
    return ok(
      await AssignmentService.listSlotCandidates(weekId, dakoId, assignmentType, assignmentId),
    );
  } catch (err) {
    return fail(err);
  }
}
