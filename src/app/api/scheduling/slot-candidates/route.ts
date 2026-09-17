import { ok, fail } from "@/server/api/helpers";
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
    const url = new URL(req.url);
    const parsed = slotCandidatesQuerySchema.safeParse({
      weekId: url.searchParams.get("weekId") ?? undefined,
      dakoId: url.searchParams.get("dakoId") ?? undefined,
      assignmentType: url.searchParams.get("assignmentType") ?? undefined,
      assignmentId: url.searchParams.get("assignmentId") ?? undefined,
    });
    if (!parsed.success) {
      return fail(new Error("invalid query"));
    }
    const { weekId, dakoId, assignmentType, assignmentId } = parsed.data;
    return ok(
      await AssignmentService.listSlotCandidates(weekId, dakoId, assignmentType, assignmentId),
    );
  } catch (err) {
    return fail(err);
  }
}
