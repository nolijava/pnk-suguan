import { ok, fail } from "@/server/api/helpers";
import { NotFoundError } from "@/lib/errors";
import { requirePermission } from "@/server/auth/guard";
import { AssignmentService } from "@/server/services";

type Params = { params: Promise<{ id: string }> };

/**
 * Phase 6 §10 — server-computed eligible replacement list for an assignment
 * slot. Filters through the SAME eligibilityCheck the engine uses, so the
 * FIL→EN rule is impossible to bypass by constructing requests.
 */
export async function GET(_req: Request, { params }: Params) {
  try {
    await requirePermission("assignments.read");
    const { id } = await params;
    const row = await AssignmentService.getAssignment(id);
    if (!row) return fail(new NotFoundError("assignment not found"));
    return ok(await AssignmentService.listEligibleReplacements(row.weekId, row.dakoId, row.id));
  } catch (err) {
    return fail(err);
  }
}
