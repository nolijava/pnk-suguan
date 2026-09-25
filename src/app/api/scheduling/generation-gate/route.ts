import { ok, fail, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { AvailabilityService } from "@/server/services";
import { generationGateQuerySchema } from "@/lib/validation/query-schemas";

/**
 * Update #22 — the WEEKLY AVAILABILITY gate probe.
 *
 * Called on Confirm, BEFORE the scheduling engine runs, so the operator is
 * blocked in exactly the order the Update specifies (Confirm → validate →
 * block or proceed). It is READ-ONLY about the week: the week row is never
 * created and nothing is generated, so a blocked probe leaves no trace beyond
 * its audit row.
 *
 * The block itself is fully server-side: an incomplete week is AUDITED
 * (GENERATION_BLOCKED, with the generation method) and answers the same
 * 422 AVAILABILITY_REQUIRED the generate endpoint answers. The POST endpoint
 * re-validates, so the gate can never be bypassed from the frontend.
 */
export async function GET(req: Request) {
  try {
    const user = await requirePermission("scheduling.generate");
    const q = parseQuery(req, generationGateQuerySchema);
    const readiness = await AvailabilityService.assertGenerationAvailability(
      q.weekId ? { weekId: q.weekId } : { year: q.year!, week: q.week! },
      user,
      q.mode ?? "auto",
    );
    return ok(readiness);
  } catch (err) {
    return fail(err);
  }
}
