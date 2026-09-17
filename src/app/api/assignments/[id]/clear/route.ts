import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

/**
 * Phase 6 §3-§5 — clear an assignment (CHANGE_OF_SUGUAN or TEACHER_ABSENT).
 * CLEARED_ASSIGNMENT + (optionally) TEACHER_MARKED_ABSENT are audited inside
 * the service transaction; PUBLISHED weeks are rejected server-side.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("assignments.write");
    const { id } = await params;
    const body = await parseBody<{ clearType: "CHANGE_OF_SUGUAN" | "TEACHER_ABSENT"; reason: string; absentReason?: string }>(req);
    return ok(await AssignmentService.clearAssignment(id, body, user));
  } catch (err) {
    return fail(err);
  }
}
