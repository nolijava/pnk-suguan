import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

/**
 * Phase 6 §8-§12 — atomic MODIFY: original teacher marked ABSENT with reason,
 * replacement teacher assigned (OVERRIDE source), in ONE transaction.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const user = await requirePermission("assignments.write");
    const { id } = await params;
    const body = await parseBody<{
      replacementTeacherId: string;
      absentReason: string;
      overrideReason?: string;
    }>(req);
    return ok(await AssignmentService.replaceAbsentTeacher(id, body, user));
  } catch (err) {
    return fail(err);
  }
}
